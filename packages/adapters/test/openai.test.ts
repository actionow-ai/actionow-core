import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';
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
});
