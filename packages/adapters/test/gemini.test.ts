import type {
  HttpClient,
  HttpRequest,
  HttpStreamResponse,
  StreamEvent,
  SubmitInput,
} from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { AdapterError } from '../src/errors.js';
import { geminiAdapter } from '../src/gemini.js';

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
  resourceId: 'model:gemini/gemini-1.5-flash',
  modality: 'text',
  inputs,
  execMode: 'blocking',
  ctx: { providerType: 'gemini', model: 'gemini-1.5-flash', apiKey: 'AIza-x', http },
});

const okBody = {
  candidates: [{ content: { parts: [{ text: 'hello' }] } }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
};

describe('gemini adapter', () => {
  it('exposes the gemini provider type', () => {
    expect(geminiAdapter.providerType).toBe('gemini');
  });

  it('submits a prompt and returns text + usage', async () => {
    const http = fakeHttp({ status: 200, body: okBody });
    const r = await geminiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(r.output.text).toBe('hello');
      expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
    }
  });

  it('targets :generateContent with the key as a query param', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await geminiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIza-x',
    );
  });

  it('maps a prompt to the contents/parts shape', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await geminiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(seen?.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
  });

  it('accepts an "input" string alias', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    await geminiAdapter.submit(baseInput(http, { input: 'yo' }));
    expect(seen?.body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'yo' }] }] });
  });

  it('maps a messages array to contents (user/model roles, content → parts)', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: okBody }, (req) => {
      seen = req;
    });
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
    ];
    await geminiAdapter.submit(baseInput(http, { messages }));
    expect(seen?.body).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'hey' }] },
      ],
    });
  });

  it('throws invalid_input when neither messages nor a prompt is given', async () => {
    const http = fakeHttp({ status: 200, body: okBody });
    await expect(geminiAdapter.submit(baseInput(http, {}))).rejects.toMatchObject({
      unified: { code: 'invalid_input', retryable: false },
    });
  });

  it('throws upstream_error when no candidate text is present', async () => {
    const http = fakeHttp({ status: 200, body: { candidates: [] } });
    await expect(geminiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it('maps a 429 to rate_limited (retryable)', async () => {
    const http = fakeHttp({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } });
    await expect(geminiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toMatchObject({
      unified: { code: 'rate_limited', retryable: true },
    });
  });

  it('extractUsage reads usageMetadata token counts', () => {
    expect(geminiAdapter.extractUsage(okBody)).toEqual({ input_tokens: 12, output_tokens: 5 });
  });
});

describe('gemini adapter stream()', () => {
  // Each gemini SSE `data:` line is a full GenerateContentResponse chunk.
  const chunkFrame = (data: Record<string, unknown>): string => `data: ${JSON.stringify(data)}\n\n`;
  const deltaFrame = (text: string): string =>
    chunkFrame({ candidates: [{ content: { parts: [{ text }] } }] });
  const finalFrame = (text: string, prompt: number, candidates: number): string =>
    chunkFrame({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: candidates },
    });

  const streamInput = (http: HttpClient, inputs: Record<string, unknown>): SubmitInput => ({
    resourceId: 'model:gemini/gemini-1.5-flash',
    modality: 'text',
    inputs,
    execMode: 'stream',
    ctx: { providerType: 'gemini', model: 'gemini-1.5-flash', apiKey: 'AIza-x', http },
  });

  const runStream = (http: HttpClient, inputs: Record<string, unknown>): Promise<StreamEvent[]> => {
    const input = streamInput(http, inputs);
    const events = geminiAdapter.stream?.(input, input.ctx);
    if (events === undefined) {
      throw new Error('gemini adapter has no stream()');
    }
    return drain(events);
  };

  it('exposes a stream method', () => {
    expect(typeof geminiAdapter.stream).toBe('function');
  });

  it('yields delta tokens then usage + done with usageMetadata from the last chunk', async () => {
    const http = fakeStreamHttp(200, [deltaFrame('hel'), finalFrame('lo', 12, 5)]);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toEqual([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'usage', usage: { input_tokens: 12, output_tokens: 5 } },
      { kind: 'done', usage: { input_tokens: 12, output_tokens: 5 } },
    ]);
  });

  it('targets :streamGenerateContent?alt=sse with the key query param', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeStreamHttp(200, [finalFrame('x', 1, 1)], (req) => {
      seen = req;
    });
    await runStream(http, { prompt: 'hi' });
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=AIza-x',
    );
    expect(seen?.body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  });

  it('uses the latest usageMetadata seen across chunks', async () => {
    const http = fakeStreamHttp(200, [
      deltaFrame('a'),
      finalFrame('b', 3, 2),
      finalFrame('c', 3, 9),
    ]);
    const events = await runStream(http, { prompt: 'hi' });
    const done = events.find((e) => e.kind === 'done');
    expect(done?.usage).toEqual({ input_tokens: 3, output_tokens: 9 });
  });

  it('emits an error event on a non-ok stream status', async () => {
    const http = fakeStreamHttp(429, []);
    const events = await runStream(http, { prompt: 'hi' });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(events[0]?.error?.code).toBe('rate_limited');
  });
});
