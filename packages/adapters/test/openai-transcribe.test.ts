import type { AdapterContext, HttpRequest, TranscriptionInput } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { AdapterError } from '../src/errors.js';
import { createMockChat } from '../src/mock-chat.js';
import { openaiAdapter } from '../src/openai.js';

/** A fake HttpClient returning the given response, capturing the request. */
const fakeHttp = (
  resp: { status: number; body: unknown },
  capture?: (req: HttpRequest) => void,
): {
  request: (
    req: HttpRequest,
  ) => Promise<{ status: number; ok: boolean; body: unknown; text: string }>;
} => ({
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

const ctxFor = (http: ReturnType<typeof fakeHttp>): AdapterContext => ({
  providerType: 'openai',
  model: 'whisper-1',
  apiKey: 'sk-x',
  http: http,
});

const irFor = (overrides: Partial<TranscriptionInput> = {}): TranscriptionInput => ({
  model: 'whisper-1',
  file: new Uint8Array([1, 2, 3, 4]),
  filename: 'clip.mp3',
  contentType: 'audio/mpeg',
  ...overrides,
});

const verboseBody = {
  text: 'hello world',
  language: 'en',
  duration: 12.5,
  segments: [{ id: 0, start: 0, end: 12.5, text: 'hello world' }],
};

describe('openai adapter — transcribe', () => {
  it('builds a multipart upstream request to /audio/transcriptions with bearer auth', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: verboseBody }, (req) => {
      seen = req;
    });
    await openaiAdapter.transcribe?.(irFor({ language: 'en' }), ctxFor(http));

    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(seen?.headers?.Authorization).toBe('Bearer sk-x');
    // The body is a FormData carrying the file + model + the verbose format.
    expect(seen?.body).toBeInstanceOf(FormData);
    const form = seen?.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('en');
    const filePart = form.get('file');
    expect(filePart).toBeInstanceOf(Blob);
    expect((filePart as File).name).toBe('clip.mp3');
  });

  it('parses text + duration into usage.audioSeconds + verbose fields', async () => {
    const http = fakeHttp({ status: 200, body: verboseBody });
    const r = await openaiAdapter.transcribe?.(irFor(), ctxFor(http));
    expect(r?.text).toBe('hello world');
    expect(r?.usage.audioSeconds).toBe(12.5);
    expect(r?.duration).toBe(12.5);
    expect(r?.language).toBe('en');
    expect(r?.segments).toHaveLength(1);
    expect(r?.segments?.[0]?.text).toBe('hello world');
  });

  it('falls back to audioSeconds 0 when the upstream omits a duration', async () => {
    const http = fakeHttp({ status: 200, body: { text: 'no duration here' } });
    const r = await openaiAdapter.transcribe?.(irFor(), ctxFor(http));
    expect(r?.text).toBe('no duration here');
    expect(r?.usage.audioSeconds).toBe(0);
    expect(r?.duration).toBeUndefined();
  });

  it('forwards prompt + temperature onto the multipart form when set', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: verboseBody }, (req) => {
      seen = req;
    });
    await openaiAdapter.transcribe?.(irFor({ prompt: 'a hint', temperature: 0.2 }), ctxFor(http));
    const form = seen?.body as FormData;
    expect(form.get('prompt')).toBe('a hint');
    expect(form.get('temperature')).toBe('0.2');
  });

  it('throws upstream_error when the response has no text', async () => {
    const http = fakeHttp({ status: 200, body: { duration: 5 } });
    await expect(openaiAdapter.transcribe?.(irFor(), ctxFor(http))).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it('maps a 429 to rate_limited (retryable)', async () => {
    const http = fakeHttp({ status: 429, body: { error: { message: 'slow down' } } });
    await expect(openaiAdapter.transcribe?.(irFor(), ctxFor(http))).rejects.toMatchObject({
      unified: { code: 'rate_limited', retryable: true },
    });
  });

  it('forwards ctx.proxyUrl onto the http request', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: verboseBody }, (req) => {
      seen = req;
    });
    const ctx = ctxFor(http);
    ctx.proxyUrl = 'http://proxy.local:8080';
    await openaiAdapter.transcribe?.(irFor(), ctx);
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
  });
});

describe('mock-chat adapter — transcribe', () => {
  it('returns a canned transcript + a byte-derived duration', async () => {
    const adapter = createMockChat();
    // 2500 bytes / 1000 B/s (mock divisor) → ceil = 3 seconds.
    const r = await adapter.transcribe?.(irFor({ file: new Uint8Array(2500) }), {
      providerType: 'mock-chat',
      http: undefined as unknown as AdapterContext['http'],
    });
    expect(r?.text).toBe('hello world');
    expect(r?.usage.audioSeconds).toBe(3);
    expect(r?.duration).toBe(3);
    expect(r?.segments).toHaveLength(1);
  });

  it('floors the duration at 1 second for a tiny upload', async () => {
    const adapter = createMockChat();
    const r = await adapter.transcribe?.(irFor({ file: new Uint8Array(10) }), {
      providerType: 'mock-chat',
      http: undefined as unknown as AdapterContext['http'],
    });
    expect(r?.usage.audioSeconds).toBe(1);
  });
});
