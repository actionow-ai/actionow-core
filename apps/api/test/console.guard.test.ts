import type { UserRecord } from '@actionow/db';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { TokenVerifierService } from '../src/auth/token-verifier.service.js';
import { ConsoleGuard, type ConsoleRepo } from '../src/console/console.guard.js';

const SECRET = 'console-test-secret';
const jwt = new JwtService({ secret: SECRET });

/** A real HS256-only verifier (no RS256 key) — the default-env path. */
const verifier = new TokenVerifierService(
  { ADMIN_JWT_SECRET: SECRET, JWT_VERIFY_LEGACY_HS256: true } as never,
  jwt,
  null,
);

function ctxFor(req: Partial<Request>): ExecutionContext {
  const request = { headers: {}, ...req } as Request;
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function repoWith(user: Partial<UserRecord> | undefined): ConsoleRepo {
  const full: UserRecord | undefined =
    user === undefined
      ? undefined
      : {
          id: 'u1',
          email: 'u@x.com',
          emailVerified: true,
          passwordHash: null,
          role: 'user',
          tenantRole: 'admin',
          status: 'active',
          tenantId: 'tenant-1',
          createdAt: new Date(),
          ...user,
        };
  return {
    findUserById: () => Promise.resolve(full),
    getAccountByTenant: () => Promise.resolve({ id: 'account-1' }),
  };
}

function guard(repo: ConsoleRepo): ConsoleGuard {
  return new ConsoleGuard(verifier, {} as never, repo);
}

async function token(sub: string): Promise<string> {
  return jwt.signAsync({ sub, role: 'user' }, { secret: SECRET, expiresIn: '5m' });
}

describe('ConsoleGuard', () => {
  it('rejects a missing token (401)', async () => {
    await expect(guard(repoWith({})).canActivate(ctxFor({ headers: {} }))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });
  it('rejects an invalid/expired token (401)', async () => {
    const bad = await new JwtService({ secret: 'other' }).signAsync({ sub: 'u1', role: 'user' });
    await expect(
      guard(repoWith({})).canActivate(ctxFor({ headers: { authorization: `Bearer ${bad}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });
  it('rejects when the user has no tenant (401)', async () => {
    const t = await token('u1');
    await expect(
      guard(repoWith({ tenantId: null })).canActivate(
        ctxFor({ headers: { authorization: `Bearer ${t}` } }),
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });
  it('rejects a disabled user (401)', async () => {
    const t = await token('u1');
    await expect(
      guard(repoWith({ status: 'disabled' })).canActivate(
        ctxFor({ headers: { authorization: `Bearer ${t}` } }),
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });
  it('attaches {userId, tenantId, accountId} on success', async () => {
    const t = await token('u1');
    const req = { headers: { authorization: `Bearer ${t}` } } as unknown as Request;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard(repoWith({})).canActivate(ctx)).resolves.toBe(true);
    const attached = (req as unknown as { console: Record<string, unknown> }).console;
    expect(attached).toMatchObject({ userId: 'u1', tenantId: 'tenant-1', accountId: 'account-1' });
  });
  it('hydrates tenantRole from the loaded user', async () => {
    const t = await token('u1');
    const req = { headers: { authorization: `Bearer ${t}` } } as unknown as Request;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard(repoWith({ tenantRole: 'member' })).canActivate(ctx)).resolves.toBe(true);
    const attached = (req as unknown as { console: Record<string, unknown> }).console;
    expect(attached.tenantRole).toBe('member');
  });
  it('defaults tenantRole to admin when the user row has null tenant_role', async () => {
    const t = await token('u1');
    const req = { headers: { authorization: `Bearer ${t}` } } as unknown as Request;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard(repoWith({ tenantRole: null })).canActivate(ctx)).resolves.toBe(true);
    const attached = (req as unknown as { console: Record<string, unknown> }).console;
    expect(attached.tenantRole).toBe('admin');
  });
});
