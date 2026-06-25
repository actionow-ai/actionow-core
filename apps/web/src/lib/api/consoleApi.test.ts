import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { makeConsoleApi } from './consoleApi';
import type { SdkClient } from './sdkClient';

interface Call {
  m: string;
  path: string;
  body?: unknown;
}

function concretePath(
  template: string,
  opts?: { params?: { path?: Record<string, string> } },
): string {
  const path = opts?.params?.path ?? {};
  return template.replace(/\{(\w+)}/g, (_m, k: string) => path[k] ?? `{${k}}`);
}

function ok(data: unknown): { data: unknown; error: undefined; response: Response } {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

/**
 * Fake SDK (records GET/POST/PATCH/DELETE) + fake raw client. Almost everything
 * now goes through the typed SDK; the `{ ok: true }` change-password and the
 * RBAC sub-user CRUD (`/console/users`, not in the SDK path set) stay on the raw
 * client (records the lowercase verbs). `getImpl`/`rawGetImpl` let a test stub a
 * GET response body (the `/console/usage` composite + the `/console/users`
 * keyset envelope respectively).
 */
function fakeApis(opts?: {
  getImpl?: (path: string) => unknown;
  rawGetImpl?: (path: string) => unknown;
}) {
  const getImpl = opts?.getImpl;
  const rawGetImpl = opts?.rawGetImpl;
  const calls: Call[] = [];

  const recordSdk = (m: string) => (template: string, sopts?: { body?: unknown }) => {
    const concrete = concretePath(template, sopts as never);
    calls.push({ m, path: concrete, body: sopts?.body });
    if (m === 'GET' && getImpl) {
      const stubbed = getImpl(concrete);
      if (stubbed !== undefined) return Promise.resolve(ok(stubbed));
    }
    const isList = m === 'GET';
    const data =
      m === 'DELETE'
        ? { id: 'k1', status: 'disabled' }
        : isList
          ? { data: [], next_cursor: null, has_more: false }
          : {};
    return Promise.resolve(ok(data));
  };

  const sdk = {
    GET: vi.fn(recordSdk('GET')),
    POST: vi.fn(recordSdk('POST')),
    PATCH: vi.fn(recordSdk('PATCH')),
    DELETE: vi.fn(recordSdk('DELETE')),
  } as unknown as SdkClient;

  const rawClient = {
    get: vi.fn((path: string) => {
      calls.push({ m: 'get', path });
      return Promise.resolve(
        rawGetImpl?.(path) ?? { data: [], next_cursor: null, has_more: false },
      );
    }),
    post: vi.fn((path: string, body?: unknown) => {
      calls.push({ m: 'post', path, body });
      return Promise.resolve({ id: 'u1', email: 'm@x.io' });
    }),
    patch: vi.fn((path: string, body?: unknown) => {
      calls.push({ m: 'patch', path, body });
      // /console/settings → { ok: true }; /console/users/:id → a ConsoleUserView.
      return Promise.resolve(
        path === '/console/settings'
          ? { ok: true }
          : {
              id: 'u1',
              email: 'm@x.io',
              status: 'active',
              tenant_role: 'admin',
              created_at: 'now',
            },
      );
    }),
    delete: vi.fn((path: string) => {
      calls.push({ m: 'delete', path });
      return Promise.resolve({ id: 'u1', status: 'disabled' });
    }),
  } as unknown as ApiClient;

  const api = makeConsoleApi(sdk, rawClient, () => undefined);
  return { api, calls };
}

describe('consoleApi (tenant self-service)', () => {
  it('rotateApiKey posts to :id/rotate; disableApiKey deletes :id', async () => {
    const { api, calls } = fakeApis();
    await api.rotateApiKey('k1');
    await api.disableApiKey('k1');
    expect(calls[0]).toMatchObject({ m: 'POST', path: '/console/api-keys/k1/rotate' });
    expect(calls[1]).toMatchObject({ m: 'DELETE', path: '/console/api-keys/k1' });
  });

  it('me GETs /console/me; changePassword PATCHes /console/settings; listPayments paginates', async () => {
    const { api, calls } = fakeApis();
    await api.me();
    await api.changePassword({ currentPassword: 'a', newPassword: 'bbbbbbbb' });
    await api.listPayments({ limit: 10 });
    expect(calls[0]).toMatchObject({ m: 'GET', path: '/console/me' });
    // changePassword stays on the raw client (preserves the `{ ok: true }` return).
    expect(calls[1]).toMatchObject({ m: 'patch', path: '/console/settings' });
    expect(calls[2]).toMatchObject({ m: 'GET', path: '/console/payments' });
  });

  it('usage maps the two page-envelopes (data→rows, next_cursor→nextCursor)', async () => {
    const { api } = fakeApis({
      getImpl: () => ({
        jobs: { data: [{ job_id: 'j1' }], next_cursor: 'jc', has_more: true },
        ledger: { data: [{ id: 'l1' }], next_cursor: null, has_more: false },
      }),
    });
    const u = await api.usage();
    expect(u.jobs.rows).toHaveLength(1);
    expect(u.jobs.nextCursor).toBe('jc');
    expect(u.ledger.rows).toHaveLength(1);
    expect(u.ledger.nextCursor).toBeNull();
  });

  // --- RBAC v1 sub-user CRUD (raw client; not in the SDK path set) ---
  it('listUsers GETs /console/users and unwraps the keyset envelope to rows', async () => {
    const { api, calls } = fakeApis({
      rawGetImpl: () => ({
        data: [
          { id: 'u1', email: 'm@x.io', status: 'active', tenant_role: 'member', created_at: 'now' },
        ],
        next_cursor: null,
        has_more: false,
      }),
    });
    const rows = await api.listUsers();
    expect(calls[0]).toMatchObject({ m: 'get', path: '/console/users' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'm@x.io', tenant_role: 'member' });
  });

  it('createUser POSTs /console/users; updateUser PATCHes :id; disableUser DELETEs :id', async () => {
    const { api, calls } = fakeApis();
    const created = await api.createUser({ email: 'm@x.io', password: 'supersecret' });
    await api.updateUser('u1', { tenantRole: 'admin' });
    await api.disableUser('u1');
    expect(calls[0]).toMatchObject({
      m: 'post',
      path: '/console/users',
      body: { email: 'm@x.io', password: 'supersecret' },
    });
    expect(created).toMatchObject({ id: 'u1', email: 'm@x.io' });
    expect(calls[1]).toMatchObject({
      m: 'patch',
      path: '/console/users/u1',
      body: { tenantRole: 'admin' },
    });
    expect(calls[2]).toMatchObject({ m: 'delete', path: '/console/users/u1' });
  });
});
