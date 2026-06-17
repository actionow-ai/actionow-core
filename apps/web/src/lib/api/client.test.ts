import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient } from './client';
import { ApiError } from './errors';

function mockResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init?.headers ?? {}),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function setup() {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const client = createClient({ getToken: () => 'tok', onUnauthorized: vi.fn() });
  return { client, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client verbs', () => {
  it('patch issues a PATCH with JSON body + auth header and returns parsed JSON', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(mockResponse({ id: 'c1', status: 'disabled' }));

    const out = await client.patch<{ id: string; status: string }>('/admin/x', {
      status: 'disabled',
    });

    expect(out).toEqual({ id: 'c1', status: 'disabled' });
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('PATCH');
    expect(opts.body).toBe(JSON.stringify({ status: 'disabled' }));
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('delete issues a DELETE', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(mockResponse(undefined, { status: 204 }));

    await client.delete('/admin/x/c1');

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('DELETE');
  });

  it('surfaces ApiError on an error envelope (patch)', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      mockResponse({ error: { code: 'invalid_input', message: 'bad' } }, { status: 400 }),
    );

    await expect(client.patch('/admin/x', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('surfaces ApiError on an error envelope (delete)', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      mockResponse({ error: { code: 'resource_not_found', message: 'nope' } }, { status: 404 }),
    );

    await expect(client.delete('/admin/x/c1')).rejects.toBeInstanceOf(ApiError);
  });

  it('getWithHeaders returns the parsed data plus response headers', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      mockResponse([{ id: 'r1' }], { headers: { 'x-actionow-channel': 'ch-7' } }),
    );

    const { data, headers } = await client.getWithHeaders<{ id: string }[]>('/admin/resources');

    expect(data).toEqual([{ id: 'r1' }]);
    expect(headers.get('x-actionow-channel')).toBe('ch-7');
  });
});
