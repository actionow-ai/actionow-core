import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMediaTransfer,
  fetchBytesWithTimeout,
  MEDIA_FETCH_TIMEOUT_MS,
  MEDIA_TRANSFER_TIMEOUTS,
  MediaTransferError,
  putBytesHashed,
  putBytesWithTimeout,
  streamUrlToPresignedPut,
  transferTimeoutForSize,
  UNKNOWN_LENGTH_BUFFER_CAP_BYTES,
} from '../src/media-bytes.js';
import { EgressBlockedError } from '../src/ssrf.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A `Response`-shaped stub carrying bytes + an optional content-type header. */
function stubResponse(bytes: Uint8Array, contentType?: string): Response {
  return {
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type' ? (contentType ?? null) : null,
    },
    arrayBuffer: (): Promise<ArrayBuffer> => {
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      return Promise.resolve(copy);
    },
  } as unknown as Response;
}

describe('fetchBytesWithTimeout', () => {
  it('returns the bytes + content type and applies a timeout signal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(stubResponse(new Uint8Array([1, 2, 3]), 'image/png'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchBytesWithTimeout('https://cdn.example.com/a.png');

    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.contentType).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cdn.example.com/a.png');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits contentType when the upstream sends no content-type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stubResponse(new Uint8Array([9])));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchBytesWithTimeout('https://cdn.example.com/x');

    expect(result.bytes).toEqual(new Uint8Array([9]));
    expect(result.contentType).toBeUndefined();
  });
});

describe('putBytesWithTimeout', () => {
  it('PUTs the bytes with a content-type header and a timeout signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stubResponse(new Uint8Array()));
    vi.stubGlobal('fetch', fetchMock);

    const bytes = new Uint8Array([4, 5, 6]);
    await putBytesWithTimeout('https://r2.local/put/key', bytes, 'image/png');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://r2.local/put/key');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(bytes);
    expect(init.headers).toEqual({ 'content-type': 'image/png' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends no content-type header when none is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stubResponse(new Uint8Array()));
    vi.stubGlobal('fetch', fetchMock);

    await putBytesWithTimeout('https://r2.local/put/key', new Uint8Array([0]));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({});
  });
});

describe('MEDIA_FETCH_TIMEOUT_MS', () => {
  it('is the shared 30s upper bound', () => {
    expect(MEDIA_FETCH_TIMEOUT_MS).toBe(30_000);
  });
});

// --- 批次4 slice5 §9.4 hardened streaming transfer -------------------------------------

/** A streaming source response: bytes delivered as a ReadableStream, arrayBuffer POISONED. */
function streamingResponse(o: {
  bytes: Uint8Array;
  contentType?: string;
  contentLength?: number | undefined;
  status?: number;
  headers?: Record<string, string>;
}): Response {
  const headers: Record<string, string> = {
    ...(o.contentType !== undefined ? { 'content-type': o.contentType } : {}),
    ...(o.contentLength !== undefined ? { 'content-length': String(o.contentLength) } : {}),
    ...o.headers,
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      // deliver in 2 chunks so counting/hashing sees a real stream
      const mid = Math.ceil(o.bytes.length / 2);
      if (mid > 0) controller.enqueue(o.bytes.slice(0, mid));
      if (o.bytes.length - mid > 0) controller.enqueue(o.bytes.slice(mid));
      controller.close();
    },
  });
  const status = o.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
    body,
    arrayBuffer: (): Promise<ArrayBuffer> => {
      throw new Error('红线 violation: streaming transfer buffered the WHOLE body (arrayBuffer)');
    },
  } as unknown as Response;
}

function okPut(): Response {
  return { ok: true, status: 200, headers: { get: (): null => null } } as unknown as Response;
}

const ALLOW = (): Promise<void> => Promise.resolve();

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

describe('transferTimeoutForSize (§9.4 按体积分级超时)', () => {
  it('tiers by announced content length; unknown → the large budget', () => {
    expect(transferTimeoutForSize(1024)).toBe(MEDIA_TRANSFER_TIMEOUTS.smallMs);
    expect(transferTimeoutForSize(MEDIA_TRANSFER_TIMEOUTS.smallMaxBytes)).toBe(
      MEDIA_TRANSFER_TIMEOUTS.smallMs,
    );
    expect(transferTimeoutForSize(MEDIA_TRANSFER_TIMEOUTS.smallMaxBytes + 1)).toBe(
      MEDIA_TRANSFER_TIMEOUTS.mediumMs,
    );
    expect(transferTimeoutForSize(MEDIA_TRANSFER_TIMEOUTS.mediumMaxBytes + 1)).toBe(
      MEDIA_TRANSFER_TIMEOUTS.largeMs,
    );
    expect(transferTimeoutForSize(undefined)).toBe(MEDIA_TRANSFER_TIMEOUTS.largeMs);
  });
});

describe('streamUrlToPresignedPut (§9.4 字节路径加固)', () => {
  it('SSRF 前置: a private-address URL is BLOCKED before any fetch', async () => {
    const fetchMock = vi.fn();
    await expect(
      streamUrlToPresignedPut(
        'http://169.254.169.254/latest/meta-data',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchMock).not.toHaveBeenCalled(); // never fetched
  });

  it('streams a known-length body straight into the PUT (no arrayBuffer), hashing + counting in flight', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const putBodies: unknown[] = [];
    const putInits: RequestInit[] = [];
    let delivered: Uint8Array | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('https://cdn.example.com/')) {
        return Promise.resolve(
          streamingResponse({ bytes, contentType: 'image/png', contentLength: bytes.length }),
        );
      }
      putBodies.push(init?.body);
      putInits.push(init ?? {});
      // A real PUT CONSUMES the request stream — the mock drains it too.
      return (async (): Promise<Response> => {
        delivered = await drain(init?.body as ReadableStream<Uint8Array>);
        return okPut();
      })();
    });

    const presign = vi.fn(
      (info: { contentType?: string | undefined; contentLength?: number | undefined }) => {
        expect(info).toEqual({ contentType: 'image/png', contentLength: bytes.length });
        return Promise.resolve({ url: 'https://r2.local/put/k.png', contentType: 'image/png' });
      },
    );

    const result = await streamUrlToPresignedPut('https://cdn.example.com/a.png', presign, {
      assertEgress: ALLOW,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // The PUT body is the PIPED stream — 禁全量进内存 (arrayBuffer is poisoned).
    expect(putBodies[0]).toBeInstanceOf(ReadableStream);
    expect(delivered).toEqual(bytes);
    expect(putInits[0]?.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(bytes.length),
    });
    expect((putInits[0] as { duplex?: string }).duplex).toBe('half'); // stream body requirement
    expect(result.bytes).toBe(bytes.length);
    expect(result.contentType).toBe('image/png');
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('re-guards EVERY redirect hop: a 302 to a private address is blocked', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === 'https://cdn.example.com/hop') {
        return Promise.resolve({
          ok: false,
          status: 302,
          headers: {
            get: (n: string): string | null =>
              n.toLowerCase() === 'location' ? 'http://10.0.0.8/internal' : null,
          },
        } as unknown as Response);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(
      streamUrlToPresignedPut(
        'https://cdn.example.com/hop',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the private hop itself was never fetched
  });

  it('unknown length: buffers UNDER the hard cap and PUTs with the measured content-length', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const putInits: RequestInit[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('https://cdn')) {
        return Promise.resolve(
          streamingResponse({ bytes, contentType: 'video/mp4', contentLength: undefined }),
        );
      }
      putInits.push(init ?? {});
      return Promise.resolve(okPut());
    });

    const result = await streamUrlToPresignedPut(
      'https://cdn.example.com/nolen',
      () => Promise.resolve({ url: 'https://r2.local/put/v.mp4', contentType: 'video/mp4' }),
      { assertEgress: ALLOW, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result.bytes).toBe(4);
    expect(putInits[0]?.headers).toMatchObject({ 'content-length': '4' });
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('unknown length OVER the cap → MediaTransferError (bounded memory, never 全量)', async () => {
    const bytes = new Uint8Array(64).fill(1);
    const fetchMock = vi.fn(() =>
      Promise.resolve(streamingResponse({ bytes, contentLength: undefined })),
    );
    await expect(
      streamUrlToPresignedPut(
        'https://cdn.example.com/big',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        {
          assertEgress: ALLOW,
          fetchImpl: fetchMock as unknown as typeof fetch,
          maxUnknownLengthBytes: 16,
        },
      ),
    ).rejects.toThrow(/buffer cap/);
  });

  it('headers phase hangs → small-tier timeout aborts with a MediaTransferError', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    );
    await expect(
      streamUrlToPresignedPut(
        'https://cdn.example.com/hang',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        {
          assertEgress: ALLOW,
          fetchImpl: fetchMock as unknown as typeof fetch,
          timeouts: { ...MEDIA_TRANSFER_TIMEOUTS, smallMs: 10 },
        },
      ),
    ).rejects.toBeInstanceOf(MediaTransferError);
  });

  it('upstream length mismatch (announced ≠ received) → MediaTransferError', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('https://cdn')) {
        return Promise.resolve(streamingResponse({ bytes, contentLength: 99 }));
      }
      return Promise.resolve(okPut());
    });
    await expect(
      streamUrlToPresignedPut(
        'https://cdn.example.com/lie',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        { assertEgress: ALLOW, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/length mismatch/);
  });

  it('non-2xx upstream / failed PUT → MediaTransferError', async () => {
    const fetch404 = vi.fn(() =>
      Promise.resolve(streamingResponse({ bytes: new Uint8Array(), status: 404 })),
    );
    await expect(
      streamUrlToPresignedPut(
        'https://cdn.example.com/miss',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        { assertEgress: ALLOW, fetchImpl: fetch404 as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/HTTP 404/);

    const fetchPutFail = vi.fn((url: string) => {
      if (url.startsWith('https://cdn')) {
        return Promise.resolve(streamingResponse({ bytes: new Uint8Array([1]), contentLength: 1 }));
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        headers: { get: (): null => null },
      } as unknown as Response);
    });
    await expect(
      streamUrlToPresignedPut(
        'https://cdn.example.com/putfail',
        () => Promise.resolve({ url: 'https://r2.local/put/x' }),
        { assertEgress: ALLOW, fetchImpl: fetchPutFail as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/storage PUT failed: HTTP 403/);
  });
});

describe('putBytesHashed + createMediaTransfer', () => {
  it('putBytesHashed uploads with content-length + sha256 result', async () => {
    const bytes = new Uint8Array([5, 5, 5]);
    const inits: RequestInit[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      inits.push(init ?? {});
      return Promise.resolve(okPut());
    });
    const r = await putBytesHashed('https://r2.local/put/b', bytes, 'audio/mpeg', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(r.bytes).toBe(3);
    expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(inits[0]?.headers).toMatchObject({
      'content-type': 'audio/mpeg',
      'content-length': '3',
    });
  });

  it('createMediaTransfer bundles both legs over shared options (engine MediaTransfer shape)', async () => {
    const bytes = new Uint8Array([1, 2]);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('https://cdn')) {
        return Promise.resolve(streamingResponse({ bytes, contentLength: 2 }));
      }
      // A real PUT consumes the request stream — the mock drains it too.
      return (async (): Promise<Response> => {
        if (init?.body instanceof ReadableStream) {
          await drain(init.body as ReadableStream<Uint8Array>);
        }
        return okPut();
      })();
    });
    const transfer = createMediaTransfer({
      assertEgress: ALLOW,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const fromUrl = await transfer.fromUrl('https://cdn.example.com/x', () =>
      Promise.resolve({ url: 'https://r2.local/put/x' }),
    );
    expect(fromUrl.bytes).toBe(2);
    const fromBytes = await transfer.fromBytes('https://r2.local/put/y', bytes);
    expect(fromBytes.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('the unknown-length default cap is the documented 32MiB bound', () => {
    expect(UNKNOWN_LENGTH_BUFFER_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
