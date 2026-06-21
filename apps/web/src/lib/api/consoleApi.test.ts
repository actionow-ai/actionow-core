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
 * now goes through the typed SDK; only the `{ ok: true }` change-password stays
 * on the raw client (records the lowercase `patch`). `getImpl` lets a test stub a
 * GET response body (used for the `/console/usage` composite).
 */
function fakeApis(getImpl?: (path: string) => unknown) {
  const calls: Call[] = [];

  const recordSdk = (m: string) => (template: string, opts?: { body?: unknown }) => {
    const concrete = concretePath(template, opts as never);
    calls.push({ m, path: concrete, body: opts?.body });
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
    patch: vi.fn((path: string, body?: unknown) => {
      calls.push({ m: 'patch', path, body });
      return Promise.resolve({ ok: true });
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
    const { api } = fakeApis(() => ({
      jobs: { data: [{ job_id: 'j1' }], next_cursor: 'jc', has_more: true },
      ledger: { data: [{ id: 'l1' }], next_cursor: null, has_more: false },
    }));
    const u = await api.usage();
    expect(u.jobs.rows).toHaveLength(1);
    expect(u.jobs.nextCursor).toBe('jc');
    expect(u.ledger.rows).toHaveLength(1);
    expect(u.ledger.nextCursor).toBeNull();
  });
});
