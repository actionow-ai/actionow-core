import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { makeMemberApi } from './memberApi';
import type { MemberKeyView } from './types';

interface Call {
  m: string;
  path: string;
  query?: unknown;
}

/**
 * Fake raw client (records the GET path + query) around the REAL `makeMemberApi`.
 * Mirrors `consoleApi.test.ts`'s `fakeApis`, but the member module is raw-only
 * (every `/member/*` route is outside the SDK path set). `getImpl` lets a test
 * stub a GET response body so the module's response-shape handling — notably the
 * `apiKeys` bare-array vs. `usage` envelope distinction — is exercised against the
 * actual transport, not pre-unwrapped data.
 */
function fakeApi(getImpl?: (path: string) => unknown) {
  const calls: Call[] = [];
  const rawClient = {
    get: vi.fn((path: string, query?: unknown) => {
      calls.push({ m: 'get', path, query });
      return Promise.resolve(getImpl?.(path) ?? {});
    }),
  } as unknown as ApiClient;
  const api = makeMemberApi(rawClient);
  return { api, calls };
}

describe('memberApi (end-user self-service)', () => {
  it('me/balance/limits GET their token-scoped /member paths', async () => {
    const { api, calls } = fakeApi();
    await api.me();
    await api.balance();
    await api.limits();
    expect(calls[0]).toMatchObject({ m: 'get', path: '/member/me' });
    expect(calls[1]).toMatchObject({ m: 'get', path: '/member/balance' });
    expect(calls[2]).toMatchObject({ m: 'get', path: '/member/limits' });
  });

  it('usage GETs /member/usage with an optional limit and returns the keyset envelope verbatim', async () => {
    const { api, calls } = fakeApi((path) =>
      path === '/member/usage'
        ? { data: [{ id: 'u1', model: 'gpt-5.5' }], next_cursor: 'c1' }
        : undefined,
    );
    const list = await api.usage(50);
    expect(calls[0]).toMatchObject({ m: 'get', path: '/member/usage', query: { limit: 50 } });
    expect(list.data).toHaveLength(1);
    expect(list.next_cursor).toBe('c1');

    // No-arg call omits the query entirely.
    const { api: api2, calls: calls2 } = fakeApi();
    await api2.usage();
    expect(calls2[0]).toMatchObject({ m: 'get', path: '/member/usage', query: undefined });
  });

  it('apiKeys GETs /member/api-keys and returns the BARE array verbatim (no envelope unwrap)', async () => {
    // The backend `GET /member/api-keys` returns a bare `MemberKeyView[]`, NOT a
    // `{ data, next_cursor }` keyset envelope. This test stubs that exact wire
    // shape so a regressed `.data` unwrap would resolve to `undefined` and fail.
    const wire: MemberKeyView[] = [
      { id: 'key-1', name: 'default', status: 'active', created_at: 'now', last4: 'ab12' },
    ];
    const { api, calls } = fakeApi((path) => (path === '/member/api-keys' ? wire : undefined));
    const rows = await api.apiKeys();
    expect(calls[0]).toMatchObject({ m: 'get', path: '/member/api-keys' });
    expect(rows).toEqual(wire);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'key-1', last4: 'ab12' });
  });
});
