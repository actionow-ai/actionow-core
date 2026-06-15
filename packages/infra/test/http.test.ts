import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchHttpClient, fetchHttpClient } from '../src/http.js';

interface StubResponseInit {
  status: number;
  contentType?: string;
  text: string;
}

/** Build a minimal `Response`-shaped object the FetchHttpClient consumes. */
const stubResponse = (init: StubResponseInit): Response =>
  ({
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type' ? (init.contentType ?? null) : null,
    },
    text: (): Promise<string> => Promise.resolve(init.text),
  }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FetchHttpClient', () => {
  it('parses a JSON body when content-type is json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stubResponse({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        text: '{"hello":"world"}',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchHttpClient.request({ method: 'GET', url: 'https://x.test/y' });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ hello: 'world' });
    expect(res.text).toBe('{"hello":"world"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves body undefined for non-JSON content but still captures text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stubResponse({
        status: 200,
        contentType: 'text/plain',
        text: 'plain text body',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchHttpClient.request({ method: 'GET', url: 'https://x.test/y' });

    expect(res.body).toBeUndefined();
    expect(res.text).toBe('plain text body');
  });

  it('guards against malformed JSON: body undefined, text preserved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stubResponse({
        status: 502,
        contentType: 'application/json',
        text: '<html>bad gateway</html>',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchHttpClient.request({ method: 'GET', url: 'https://x.test/y' });

    expect(res.status).toBe(502);
    expect(res.ok).toBe(false);
    expect(res.body).toBeUndefined();
    expect(res.text).toBe('<html>bad gateway</html>');
  });

  it('serializes a JSON body and sets headers + content-type for POST', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{"ok":true}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await fetchHttpClient.request({
      method: 'POST',
      url: 'https://x.test/y',
      headers: { authorization: 'Bearer k' },
      body: { a: 1 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.test/y');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k');
    expect(headers['content-type']).toBe('application/json');
  });

  it('aborts and throws when the request exceeds timeoutMs', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await expect(
      client.request({ method: 'GET', url: 'https://x.test/slow', timeoutMs: 5 }),
    ).rejects.toThrow();
  });

  it('exports a shared singleton instance', () => {
    expect(fetchHttpClient).toBeInstanceOf(FetchHttpClient);
  });
});
