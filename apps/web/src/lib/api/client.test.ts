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

  it('put issues a PUT with JSON body + auth header and no Idempotency-Key', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      mockResponse({ group_id: 'g1', channel_id: 'c1', priority: 0, weight: 1 }),
    );

    const out = await client.put<{ group_id: string; channel_id: string }>(
      '/admin/route-groups/g1/channels/c1',
      { priority: 0, weight: 1 },
    );

    expect(out).toEqual({ group_id: 'g1', channel_id: 'c1', priority: 0, weight: 1 });
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('PUT');
    expect(opts.body).toBe(JSON.stringify({ priority: 0, weight: 1 }));
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    // The PUT verb is the idempotency — never send an Idempotency-Key header.
    expect((opts.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
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

  it('getPage unwraps the {data,next_cursor} envelope into {rows,nextCursor}', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      mockResponse({ data: [{ id: 'r1' }, { id: 'r2' }], next_cursor: 'c2', has_more: true }),
    );

    const page = await client.getPage<{ id: string }>('/admin/resources', { limit: 2 });

    expect(page).toEqual({ rows: [{ id: 'r1' }, { id: 'r2' }], nextCursor: 'c2' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('limit=2');
  });

  it('getPage maps a final page (next_cursor null) to nextCursor null', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(mockResponse({ data: [], next_cursor: null, has_more: false }));

    const page = await client.getPage<{ id: string }>('/admin/jobs');

    expect(page).toEqual({ rows: [], nextCursor: null });
  });

  it('post with idempotencyKey sends the Idempotency-Key header', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(mockResponse({ id: 'r1' }));

    await client.post('/admin/resources', { id: 'r1' }, { idempotencyKey: 'idem-123' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-123');
  });

  it('post without opts omits the Idempotency-Key header', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(mockResponse({ id: 'r1' }));

    await client.post('/admin/resources', { id: 'r1' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });
});
