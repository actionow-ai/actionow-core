import type {
  HttpClient,
  HttpRequest,
  HttpStreamResponse,
  StreamEvent,
  SubmitInput,
} from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../src/anthropic.js';
import { AdapterError } from '../src/errors.js';

const fakeHttp = (
  resp: { status: number; body: unknown },
  capture?: (req: HttpRequest) => void,
): HttpClient => ({
  request: (req: HttpRequest) => {
    capture?.(req);
    return Promise.resolve({
      status: resp.status,
      ok: resp.status < 400,
      body: resp.body,
      text: JSON.stringify(resp.body),
    });
  },
});

/** Yield an array of pre-canned SSE frame strings as decoded chunks. */
function framesOf(frames: string[]): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* gen(): AsyncIterable<string> {
    for (const frame of frames) {
      yield frame;
    }
  })();
}

/** A fake HttpClient whose `stream()` returns the given SSE frames. */
const fakeStreamHttp = (
  status: number,
  frames: string[],
  capture?: (req: HttpRequest) => void,
): HttpClient => ({
  request: () => Promise.reject(new Error('not used in stream tests')),
  stream: (req: HttpRequest): Promise<HttpStreamResponse> => {
    capture?.(req);
    return Promise.resolve({ status, ok: status < 400, lines: framesOf(frames) });
  },
});

/** Drain an adapter stream into an array of {@link StreamEvent}s. */
async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) {
    out.push(ev);
  }
  return out;
}

const baseInput = (http: HttpClient, inputs: Record<string, unknown>): SubmitInput => ({
  resourceId: 'model:anthropic/claude-3-5-sonnet',
  modality: 'text',
  inputs,
  execMode: 'blocking',
  ctx: { providerType: 'anthropic', model: 'claude-3-5-sonnet', apiKey: 'sk-ant', http },
});

const okBody = {
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 12, output_tokens: 5 },
};

describe('anthropic adapter', () => {
  it('exposes the anthropic provider type', () => {
    expect(anthropicAdapter.providerType).toBe('anthropic');
  });

  it('submits a prompt and returns text + usage', async () => {
    const http = fakeHttp({ status: 200, body: okBody });
    const r = await anthropicAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(r.output.text).toBe('hello');
      expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
    }
  });

  it('targets /v1/messages with x-api-key and anthropic-version headers', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await anthropicAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen?.headers?.['x-api-key']).toBe('sk-ant');
    expect(seen?.headers?.['anthropic-version']).toBe('2023-06-01');
  });

  it('defaults max_tokens to 1024 and wraps a prompt as a user message', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await anthropicAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(seen?.body).toMatchObject({
      model: 'claude-3-5-sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('forwards an explicit max_tokens and system prompt', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await anthropicAdapter.submit(
      baseInput(http, { prompt: 'hi', max_tokens: 256, system: 'be terse' }),
    );
    expect(seen?.body).toMatchObject({ max_tokens: 256, system: 'be terse' });
  });

  it('passes a messages array through unchanged', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    const messages = [{ role: 'user', content: 'hi' }];
    await anthropicAdapter.submit(baseInput(http, { messages }));
    expect(seen?.body).toMatchObject({ messages });
  });

  it('throws invalid_input when neither messages nor a prompt is given', async () => {
    const http = fakeHttp({ status: 200, body: okBody });
    await expect(anthropicAdapter.submit(baseInput(http, {}))).rejects.toMatchObject({
      unified: { code: 'invalid_input', retryable: false },
    });
  });

  it('throws upstream_error when the response has no text block', async () => {
    const http = fakeHttp({ status: 200, body: { content: [] } });
    await expect(anthropicAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it('maps a 401 to unauthorized (non-retryable)', async () => {
    const http = fakeHttp({ status: 401, body: { error: { type: 'authentication_error' } } });
    await expect(anthropicAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toMatchObject({
      unified: {
        code: 'unauthorized',
        retryable: false,
        upstream: { provider: 'anthropic', rawCode: 'authentication_error' },
      },
    });
  });

  it('extractUsage reads input/output tokens directly', () => {
    expect(anthropicAdapter.extractUsage(okBody)).toEqual({ input_tokens: 12, output_tokens: 5 });
  });
});

describe('anthropic adapter stream()', () => {
  // Anthropic frames each carry both an `event:` and a `data:` line.
  const frame = (event: string, data: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const messageStart = frame('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 12, output_tokens: 0 } },
  });
  const blockDelta = (text: string): string =>
    frame('content_block_delta', {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    });
  const messageDelta = (output: number): string =>
    frame('message_delta', { type: 'message_delta', usage: { output_tokens: output } });
  const messageStop = frame('message_stop', { type: 'message_stop' });

  const streamInput = (http: HttpClient, inputs: Record<string, unknown>): SubmitInput => ({
    resourceId: 'model:anthropic/claude-3-5-sonnet',
    modality: 'text',
    inputs,
    execMode: 'stream',
    ctx: { providerType: 'anthropic', model: 'claude-3-5-sonnet', apiKey: 'sk-ant', http },
  });

  const runStream = (http: HttpClient, inputs: Record<string, unknown>): Promise<StreamEvent[]> => {
    const input = streamInput(http, inputs);
    const events = anthropicAdapter.stream?.(input, input.ctx);
    if (events === undefined) {
      throw new Error('anthropic adapter has no stream()');
    }
    return drain(events);
  };

  it('exposes a stream method', () => {
    expect(typeof anthropicAdapter.stream).toBe('function');
  });

  it('yields deltas then usage + done with input from message_start and output from message_delta', async () => {
    const http = fakeStreamHttp(200, [
      messageStart,
      blockDelta('hel'),
      blockDelta('lo'),
      messageDelta(5),
      messageStop,
    ]);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toEqual([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'usage', usage: { input_tokens: 12, output_tokens: 5 } },
      { kind: 'done', usage: { input_tokens: 12, output_tokens: 5 } },
    ]);
  });

  it('requests stream:true against /v1/messages with x-api-key + version headers', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeStreamHttp(
      200,
      [messageStart, blockDelta('x'), messageDelta(1), messageStop],
      (req) => {
        seen = req;
      },
    );
    await runStream(http, { prompt: 'hi', max_tokens: 256 });
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen?.headers?.['x-api-key']).toBe('sk-ant');
    expect(seen?.headers?.['anthropic-version']).toBe('2023-06-01');
    expect(seen?.body).toMatchObject({
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('takes the last message_delta output_tokens as the cumulative final', async () => {
    const http = fakeStreamHttp(200, [
      messageStart,
      blockDelta('a'),
      messageDelta(2),
      blockDelta('b'),
      messageDelta(7),
      messageStop,
    ]);
    const events = await runStream(http, { prompt: 'hi' });
    const done = events.find((e) => e.kind === 'done');
    expect(done?.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it('emits an error event on a non-ok stream status', async () => {
    const http = fakeStreamHttp(401, []);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(events[0]?.error?.code).toBe('unauthorized');
  });
});
