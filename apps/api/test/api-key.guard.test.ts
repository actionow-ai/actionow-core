import { createHash } from 'node:crypto';

import type { ApiKeyRecord } from '@actionow/db';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { ApiKeyGuard, type ApiKeyRepo } from '../src/auth/api-key.guard.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Build an ExecutionContext wrapping a fake express Request. */
function ctxFor(req: Partial<Request>): ExecutionContext {
  const request = { headers: {}, params: {}, ...req } as Request;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const validKey = 'ak_testkey';
const validHash = sha256(validKey);

function repoWithKey(record: Partial<ApiKeyRecord> = {}): ApiKeyRepo {
  const full: ApiKeyRecord = {
    id: 'key-1',
    tenantId: 'tenant-1',
    resourceAllowlist: [],
    rateLimit: null,
    status: 'active',
    ...record,
  };
  return {
    findApiKeyByHash: (_db, hash): Promise<ApiKeyRecord | undefined> =>
      Promise.resolve(hash === validHash ? full : undefined),
    getAccountByTenant: (): Promise<{ id: string } | undefined> =>
      Promise.resolve({ id: 'account-1' }),
  };
}

function guard(repo: ApiKeyRepo, nodeEnv = 'production'): ApiKeyGuard {
  return new ApiKeyGuard({} as never, repo, { NODE_ENV: nodeEnv } as never);
}

function guardWithFlag(repo: ApiKeyRepo, allowDevHeader: boolean): ApiKeyGuard {
  return new ApiKeyGuard({} as never, repo, {
    NODE_ENV: 'development',
    ALLOW_DEV_TENANT_HEADER: allowDevHeader,
  } as never);
}

describe('ApiKeyGuard', () => {
  it('rejects a request with no credentials (401 unauthorized envelope)', async () => {
    const g = guard(repoWithKey());
    await expect(g.canActivate(ctxFor({ headers: {} }))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects an unknown key', async () => {
    const g = guard(repoWithKey());
    await expect(
      g.canActivate(ctxFor({ headers: { authorization: 'Bearer ak_wrong' } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects a disabled key', async () => {
    const g = guard(repoWithKey({ status: 'disabled' }));
    await expect(
      g.canActivate(ctxFor({ headers: { authorization: `Bearer ${validKey}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('accepts a valid Bearer key and attaches the tenant context', async () => {
    const g = guard(repoWithKey());
    const req = {
      headers: { authorization: `Bearer ${validKey}` },
      params: {},
    } as unknown as Request;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(g.canActivate(ctx)).resolves.toBe(true);

    const auth = (req as unknown as { auth: Record<string, unknown> }).auth;
    expect(auth).toMatchObject({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      apiKeyId: 'key-1',
      resourceAllowlist: [],
      rateLimit: null,
    });
  });

  it('accepts a valid key via the x-api-key header', async () => {
    const g = guard(repoWithKey());
    const req = { headers: { 'x-api-key': validKey }, params: {} } as unknown as Request;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    await expect(g.canActivate(ctx)).resolves.toBe(true);
  });

  it('blocks a resource not in a non-empty allowlist', async () => {
    const g = guard(repoWithKey({ resourceAllowlist: ['allowed-resource'] }));
    const ctx = ctxFor({
      headers: { authorization: `Bearer ${validKey}` },
      params: { resourceId: 'forbidden-resource' },
    });
    await expect(g.canActivate(ctx)).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('allows a resource that is in the allowlist', async () => {
    const g = guard(repoWithKey({ resourceAllowlist: ['allowed-resource'] }));
    const ctx = ctxFor({
      headers: { authorization: `Bearer ${validKey}` },
      params: { resourceId: 'allowed-resource' },
    });
    await expect(g.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects when the tenant has no account', async () => {
    const repo = {
      findApiKeyByHash: (): Promise<ApiKeyRecord | undefined> =>
        Promise.resolve({
          id: 'key-1',
          tenantId: 'tenant-1',
          resourceAllowlist: [],
          rateLimit: null,
          status: 'active',
        }),
      getAccountByTenant: (): Promise<{ id: string } | undefined> => Promise.resolve(undefined),
    } as unknown as ApiKeyRepo;
    const g = guard(repo);
    await expect(
      g.canActivate(ctxFor({ headers: { authorization: `Bearer ${validKey}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  describe('x-tenant-id dev fallback', () => {
    it('is honored outside production when no key is present', async () => {
      const g = guardWithFlag(repoWithKey(), true);
      const req = { headers: { 'x-tenant-id': 'dev-tenant' }, params: {} } as unknown as Request;
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;

      await expect(g.canActivate(ctx)).resolves.toBe(true);
      const auth = (req as unknown as { auth: Record<string, unknown> }).auth;
      expect(auth).toMatchObject({ tenantId: 'dev-tenant', accountId: 'account-1' });
    });

    it('is ignored in production (still requires a key)', async () => {
      const g = guard(repoWithKey(), 'production');
      await expect(
        g.canActivate(ctxFor({ headers: { 'x-tenant-id': 'dev-tenant' } })),
      ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });
  });

  describe('x-tenant-id requires the explicit ALLOW_DEV_TENANT_HEADER flag', () => {
    it('honored when the flag is true (non-prod)', async () => {
      const g = guardWithFlag(repoWithKey(), true);
      const req = { headers: { 'x-tenant-id': 'dev-tenant' }, params: {} } as unknown as Request;
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      await expect(g.canActivate(ctx)).resolves.toBe(true);
    });
    it('rejected when the flag is false even in non-prod', async () => {
      const g = guardWithFlag(repoWithKey(), false);
      await expect(
        g.canActivate(ctxFor({ headers: { 'x-tenant-id': 'dev-tenant' } })),
      ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });
  });
});
