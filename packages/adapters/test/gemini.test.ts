import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';
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
