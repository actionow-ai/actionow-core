import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchBytesWithTimeout,
  MEDIA_FETCH_TIMEOUT_MS,
  putBytesWithTimeout,
} from '../src/media-bytes.js';

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
