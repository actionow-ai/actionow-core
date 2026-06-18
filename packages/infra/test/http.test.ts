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

describe('FetchHttpClient proxy support', () => {
  it('passes an undici dispatcher to fetch when proxyUrl is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{"ok":true}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.request({
      method: 'GET',
      url: 'https://x.test/y',
      proxyUrl: 'http://proxy.local:8080',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });

  it('does not pass a dispatcher when proxyUrl is absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{"ok":true}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.request({ method: 'GET', url: 'https://x.test/y' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeUndefined();
  });

  it('reuses one ProxyAgent per proxyUrl across requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.request({ method: 'GET', url: 'https://x.test/a', proxyUrl: 'http://p:8080' });
    await client.request({ method: 'GET', url: 'https://x.test/b', proxyUrl: 'http://p:8080' });

    const d1 = (fetchMock.mock.calls[0]?.[1] as { dispatcher?: unknown }).dispatcher;
    const d2 = (fetchMock.mock.calls[1]?.[1] as { dispatcher?: unknown }).dispatcher;
    expect(d1).toBe(d2);
  });

  it('passes a dispatcher to stream() when proxyUrl is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stubStreamResponse(200, ['data: x\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.stream({
      method: 'POST',
      url: 'https://x.test/stream',
      proxyUrl: 'http://proxy.local:8080',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });
});

/** Build a `Response`-shaped object whose `body` is a `ReadableStream` of bytes. */
const stubStreamResponse = (status: number, frames: string[]): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
  } as unknown as Response;
};

describe('FetchHttpClient.stream', () => {
  it('iterates decoded UTF-8 chunks of a ReadableStream body (two SSE frames)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(stubStreamResponse(200, ['data: one\n\n', 'data: two\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchHttpClient.stream({
      method: 'POST',
      url: 'https://x.test/stream',
      body: { stream: true },
    });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);

    const seen: string[] = [];
    for await (const chunk of res.lines) {
      seen.push(chunk);
    }
    expect(seen.join('')).toBe('data: one\n\ndata: two\n\n');
  });

  it('serializes a JSON body and sets the content-type header for POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stubStreamResponse(200, ['data: x\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    await fetchHttpClient.stream({
      method: 'POST',
      url: 'https://x.test/stream',
      headers: { authorization: 'Bearer k' },
      body: { a: 1 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.test/stream');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k');
    expect(headers['content-type']).toBe('application/json');
  });

  it('reports a non-ok status without a body without throwing', async () => {
    const noBody = { status: 429, ok: false, body: null } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(noBody);
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchHttpClient.stream({ method: 'POST', url: 'https://x.test/stream' });
    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);

    const seen: string[] = [];
    for await (const chunk of res.lines) {
      seen.push(chunk);
    }
    expect(seen).toEqual([]);
  });

  it('aborts a stalled stream after the idle timeout (no byte within idleTimeoutMs)', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(): void {
        // Never enqueue and never close → the upstream stalls forever.
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const stalled = { status: 200, ok: true, body } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(stalled);
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    const res = await client.stream({
      method: 'POST',
      url: 'https://x.test/stream',
      idleTimeoutMs: 30,
    });

    const chunks: string[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const chunk of res.lines) chunks.push(chunk);
      })(),
    ).rejects.toMatchObject({ unified: { code: 'upstream_timeout', retryable: true } });
    // The idle timer fired before any chunk arrived.
    expect(chunks).toHaveLength(0);

    // The idle abort tore down the upstream connection.
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it('does not abort a stream that keeps sending within the idle window', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        // Three frames, each well within the 100ms idle window → no timeout.
        for (const f of ['data: a\n\n', 'data: b\n\n', 'data: c\n\n']) {
          controller.enqueue(encoder.encode(f));
          await new Promise((r) => setTimeout(r, 20));
        }
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, body });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    const res = await client.stream({
      method: 'POST',
      url: 'https://x.test/stream',
      idleTimeoutMs: 100,
    });
    const seen: string[] = [];
    for await (const chunk of res.lines) seen.push(chunk);
    expect(seen.join('')).toBe('data: a\n\ndata: b\n\ndata: c\n\n');
  });

  it('releases the reader when the consumer stops early (break)', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode('data: one\n\n'));
        controller.enqueue(encoder.encode('data: two\n\n'));
        // deliberately leave the stream open
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const openStream = { status: 200, ok: true, body } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(openStream);
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchHttpClient.stream({ method: 'POST', url: 'https://x.test/stream' });
    for await (const chunk of res.lines) {
      expect(chunk).toBe('data: one\n\n');
      break; // early return → generator finally must release the reader
    }
    // Give the microtask queue a tick for the cancel to propagate.
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});
