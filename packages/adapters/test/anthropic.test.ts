import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';
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
