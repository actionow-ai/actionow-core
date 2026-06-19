import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { makeConsoleApi } from './consoleApi';

function fakeClient(getImpl?: (path: string) => unknown) {
  const calls: { m: string; path: string; body?: unknown }[] = [];
  const client = {
    get: vi.fn((path: string) => {
      calls.push({ m: 'get', path });
      return Promise.resolve(getImpl ? getImpl(path) : {});
    }),
    getPage: vi.fn((path: string) => {
      calls.push({ m: 'getPage', path });
      return Promise.resolve({ rows: [], nextCursor: null });
    }),
    post: vi.fn((path: string, body?: unknown) => {
      calls.push({ m: 'post', path, body });
      return Promise.resolve({});
    }),
    patch: vi.fn((path: string, body?: unknown) => {
      calls.push({ m: 'patch', path, body });
      return Promise.resolve({ ok: true });
    }),
    delete: vi.fn((path: string) => {
      calls.push({ m: 'delete', path });
      return Promise.resolve({ id: 'k1', status: 'disabled' });
    }),
  } as unknown as ApiClient;
  return { client, calls };
}

describe('consoleApi (tenant self-service)', () => {
  it('rotateApiKey posts to :id/rotate; disableApiKey deletes :id', async () => {
    const { client, calls } = fakeClient();
    const api = makeConsoleApi(client);
    await api.rotateApiKey('k1');
    await api.disableApiKey('k1');
    expect(calls[0]).toMatchObject({ m: 'post', path: '/console/api-keys/k1/rotate' });
    expect(calls[1]).toMatchObject({ m: 'delete', path: '/console/api-keys/k1' });
  });

  it('me GETs /console/me; changePassword PATCHes /console/settings; listPayments paginates', async () => {
    const { client, calls } = fakeClient();
    const api = makeConsoleApi(client);
    await api.me();
    await api.changePassword({ currentPassword: 'a', newPassword: 'bbbbbbbb' });
    await api.listPayments({ limit: 10 });
    expect(calls[0]).toMatchObject({ m: 'get', path: '/console/me' });
    expect(calls[1]).toMatchObject({ m: 'patch', path: '/console/settings' });
    expect(calls[2]).toMatchObject({ m: 'getPage', path: '/console/payments' });
  });

  it('usage maps the two page-envelopes (data→rows, next_cursor→nextCursor)', async () => {
    const { client } = fakeClient(() => ({
      jobs: { data: [{ job_id: 'j1' }], next_cursor: 'jc', has_more: true },
      ledger: { data: [{ id: 'l1' }], next_cursor: null, has_more: false },
    }));
    const u = await makeConsoleApi(client).usage();
    expect(u.jobs.rows).toHaveLength(1);
    expect(u.jobs.nextCursor).toBe('jc');
    expect(u.ledger.rows).toHaveLength(1);
    expect(u.ledger.nextCursor).toBeNull();
  });
});
