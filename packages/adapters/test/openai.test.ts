import type {
  HttpClient,
  HttpRequest,
  HttpStreamResponse,
  StreamEvent,
  SubmitInput,
} from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { AdapterError } from '../src/errors.js';
import { openaiAdapter } from '../src/openai.js';

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
  resourceId: 'model:openai/gpt-4o-mini',
  modality: 'text',
  inputs,
  execMode: 'blocking',
  ctx: { providerType: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x', http },
});

const okBody = {
  choices: [{ message: { content: 'hello' } }],
  usage: { prompt_tokens: 12, completion_tokens: 5 },
};

describe('openai adapter', () => {
  it('exposes the openai provider type', () => {
    expect(openaiAdapter.providerType).toBe('openai');
  });

  it('submits a prompt and returns text + usage', async () => {
    const http = fakeHttp({ status: 200, body: okBody });
    const r = await openaiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(r.output.text).toBe('hello');
      expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
    }
  });

  it('builds the request against the default endpoint with bearer auth', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await openaiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen?.headers?.Authorization).toBe('Bearer sk-x');
    expect(seen?.body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('honors a custom endpoint without a trailing slash duplication', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    const input = baseInput(http, { prompt: 'hi' });
    input.ctx.endpoint = 'https://proxy.local/v1';
    await openaiAdapter.submit(input);
    expect(seen?.url).toBe('https://proxy.local/v1/chat/completions');
  });

  it('accepts an "input" string alias for the prompt', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await openaiAdapter.submit(baseInput(http, { input: 'yo' }));
    expect(seen?.body).toMatchObject({ messages: [{ role: 'user', content: 'yo' }] });
  });

  it('passes a messages array through unchanged', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    const messages = [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ];
    await openaiAdapter.submit(baseInput(http, { messages }));
    expect(seen?.body).toMatchObject({ messages });
  });

  it('forwards max_tokens when provided', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await openaiAdapter.submit(baseInput(http, { prompt: 'hi', max_tokens: 64 }));
    expect(seen?.body).toMatchObject({ max_tokens: 64 });
  });

  it('throws invalid_input when neither messages nor a prompt is given', async () => {
    const http = fakeHttp({ status: 200, body: okBody });
    await expect(openaiAdapter.submit(baseInput(http, {}))).rejects.toMatchObject({
      unified: { code: 'invalid_input', retryable: false },
    });
  });

  it('throws upstream_error when the response has no content', async () => {
    const http = fakeHttp({ status: 200, body: { choices: [{ message: {} }] } });
    await expect(openaiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it('defaults usage to zero when usage is absent', async () => {
    const http = fakeHttp({ status: 200, body: { choices: [{ message: { content: 'x' } }] } });
    const r = await openaiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    if (r.kind === 'sync') {
      expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    }
  });

  it('maps a 429 to rate_limited (retryable)', async () => {
    const http = fakeHttp({ status: 429, body: { error: { message: 'slow down' } } });
    await expect(openaiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toMatchObject({
      unified: { code: 'rate_limited', retryable: true },
    });
  });

  it('maps a 401 to unauthorized (non-retryable)', async () => {
    const http = fakeHttp({ status: 401, body: { error: { message: 'bad key' } } });
    await expect(openaiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toMatchObject({
      unified: { code: 'unauthorized', retryable: false },
    });
  });

  it('maps a 500 to upstream_error (retryable) and threads the upstream code', async () => {
    const http = fakeHttp({ status: 500, body: { error: { code: 'server_error' } } });
    await expect(openaiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toMatchObject({
      unified: {
        code: 'upstream_error',
        retryable: true,
        upstream: { provider: 'openai', rawCode: 'server_error' },
      },
    });
  });

  it('extractUsage reads prompt/completion tokens directly', () => {
    expect(openaiAdapter.extractUsage(okBody)).toEqual({ input_tokens: 12, output_tokens: 5 });
  });

  it('forwards ctx.proxyUrl onto the http request', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    const input = baseInput(http, { prompt: 'hi' });
    input.ctx.proxyUrl = 'http://proxy.local:8080';
    await openaiAdapter.submit(input);
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
  });

  it('omits proxyUrl on the http request when ctx.proxyUrl is unset', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await openaiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(seen?.proxyUrl).toBeUndefined();
  });
});

describe('openai adapter stream()', () => {
  const deltaFrame = (content: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const usageFrame = (prompt: number, completion: number): string =>
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    })}\n\n`;
  const doneFrame = 'data: [DONE]\n\n';

  const streamInput = (http: HttpClient, inputs: Record<string, unknown>): SubmitInput => ({
    resourceId: 'model:openai/gpt-4o-mini',
    modality: 'text',
    inputs,
    execMode: 'stream',
    ctx: { providerType: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x', http },
  });

  /** Build the input + invoke the adapter's stream() with its own context. */
  const runStream = (http: HttpClient, inputs: Record<string, unknown>): Promise<StreamEvent[]> => {
    const input = streamInput(http, inputs);
    const events = openaiAdapter.stream?.(input, input.ctx);
    if (events === undefined) {
      throw new Error('openai adapter has no stream()');
    }
    return drain(events);
  };

  it('exposes a stream method', () => {
    expect(typeof openaiAdapter.stream).toBe('function');
  });

  it('yields delta tokens then a usage + done with normalized usage', async () => {
    const http = fakeStreamHttp(200, [
      deltaFrame('hel'),
      deltaFrame('lo'),
      usageFrame(12, 5),
      doneFrame,
    ]);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toEqual([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'usage', usage: { input_tokens: 12, output_tokens: 5 } },
      { kind: 'done', usage: { input_tokens: 12, output_tokens: 5 } },
    ]);
  });

  it('requests stream:true with stream_options.include_usage and bearer auth', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeStreamHttp(200, [deltaFrame('x'), usageFrame(1, 1), doneFrame], (req) => {
      seen = req;
    });
    await runStream(http, { prompt: 'hi' });
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen?.headers?.Authorization).toBe('Bearer sk-x');
    expect(seen?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('stops at [DONE] and still emits a done event even without a usage frame', async () => {
    const http = fakeStreamHttp(200, [deltaFrame('only'), doneFrame]);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toEqual([
      { kind: 'delta', text: 'only' },
      { kind: 'done', usage: { input_tokens: 0, output_tokens: 0 } },
    ]);
  });

  it('emits an error event when the upstream stream returns a non-ok status', async () => {
    const http = fakeStreamHttp(429, []);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(events[0]?.error?.code).toBe('rate_limited');
  });

  it('skips empty deltas (no content)', async () => {
    const http = fakeStreamHttp(200, [
      'data: {"choices":[{"delta":{}}]}\n\n',
      deltaFrame('hi'),
      doneFrame,
    ]);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events.filter((e) => e.kind === 'delta')).toEqual([{ kind: 'delta', text: 'hi' }]);
  });

  it('forwards ctx.proxyUrl onto the stream request', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeStreamHttp(200, [deltaFrame('x'), doneFrame], (req) => {
      seen = req;
    });
    const input = streamInput(http, { prompt: 'hi' });
    input.ctx.proxyUrl = 'http://proxy.local:8080';
    const events = openaiAdapter.stream?.(input, input.ctx);
    if (events === undefined) {
      throw new Error('openai adapter has no stream()');
    }
    await drain(events);
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
  });
});
