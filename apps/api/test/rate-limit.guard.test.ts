import type { RateLimiter, RateLimitResult } from '@actionow/infra';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyContext, AuthedRequest } from '../src/auth/api-key.guard.js';
import { RateLimitGuard } from '../src/auth/rate-limit.guard.js';

interface GuardEnv {
  RATE_LIMIT_TENANT_PER_MIN: number;
  RATE_LIMIT_RESOURCE_PER_MIN: number;
}

const env: GuardEnv = { RATE_LIMIT_TENANT_PER_MIN: 100, RATE_LIMIT_RESOURCE_PER_MIN: 60 };

function ctxWith(auth: ApiKeyContext | undefined, resourceId = 'res-1'): ExecutionContext {
  const req = { params: { resourceId }, auth } as unknown as AuthedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => req as Request }),
  } as unknown as ExecutionContext;
}

const authCtx: ApiKeyContext = {
  tenantId: 't1',
  accountId: 'a1',
  apiKeyId: 'k1',
  resourceAllowlist: [],
  rateLimit: null,
  routeGroupId: null,
};

function allow(): RateLimitResult {
  return { allowed: true, retryAfterMs: 0 };
}
function block(ms = 5_000): RateLimitResult {
  return { allowed: false, retryAfterMs: ms };
}

function makeLimiter(impl: (key: string, limit: number) => RateLimitResult): RateLimiter {
  return { take: (key, limit): Promise<RateLimitResult> => Promise.resolve(impl(key, limit)) };
}

function guard(limiter: RateLimiter): RateLimitGuard {
  return new RateLimitGuard(limiter, env as never);
}

describe('RateLimitGuard', () => {
  it('allows when both buckets are under budget', async () => {
    const g = guard(makeLimiter(() => allow()));
    await expect(g.canActivate(ctxWith(authCtx))).resolves.toBe(true);
  });

  it('checks a per-tenant bucket and a per-(tenant,resource) bucket', async () => {
    const take = vi.fn((key: string): RateLimitResult => {
      void key;
      return allow();
    });
    const g = guard({ take: (key): Promise<RateLimitResult> => Promise.resolve(take(key)) });
    await g.canActivate(ctxWith(authCtx));

    const keys = take.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(expect.arrayContaining([expect.stringContaining('t1')]));
    // Two distinct buckets are consulted (tenant-wide + tenant+resource).
    expect(new Set(keys).size).toBe(2);
  });

  it('429 rate_limited with retry_after_ms when the tenant bucket is exceeded', async () => {
    const g = guard(makeLimiter((key) => (key.includes('res-1') ? allow() : block(7_000))));
    await expect(g.canActivate(ctxWith(authCtx))).rejects.toMatchObject({
      unified: { code: 'rate_limited', retryable: true, retryAfterMs: 7_000 },
    });
  });

  it('429 when the resource bucket is exceeded', async () => {
    const g = guard(makeLimiter((key) => (key.includes('res-1') ? block(3_000) : allow())));
    await expect(g.canActivate(ctxWith(authCtx))).rejects.toMatchObject({
      unified: { code: 'rate_limited', retryAfterMs: 3_000 },
    });
  });

  it("uses the key's rateLimit for the resource bucket when present", async () => {
    const limits: Record<string, number> = {};
    const limiter = makeLimiter((key, limit) => {
      limits[key.includes('res-1') ? 'resource' : 'tenant'] = limit;
      return allow();
    });
    const g = guard(limiter);
    await g.canActivate(ctxWith({ ...authCtx, rateLimit: 42 }));
    expect(limits.resource).toBe(42);
    // The tenant bucket still uses the configured default.
    expect(limits.tenant).toBe(env.RATE_LIMIT_TENANT_PER_MIN);
  });

  it('falls back to the configured resource default when the key has no rateLimit', async () => {
    const limits: Record<string, number> = {};
    const limiter = makeLimiter((key, limit) => {
      if (key.includes('res-1')) limits.resource = limit;
      return allow();
    });
    const g = guard(limiter);
    await g.canActivate(ctxWith({ ...authCtx, rateLimit: null }));
    expect(limits.resource).toBe(env.RATE_LIMIT_RESOURCE_PER_MIN);
  });

  it('fails closed (unauthorized) when req.auth is missing', async () => {
    const g = guard(makeLimiter(() => allow()));
    await expect(g.canActivate(ctxWith(undefined))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });
});
