import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import type { AdminRequest } from '../src/admin/auth/admin.guard.js';
import { AdminGuard } from '../src/admin/auth/admin.guard.js';
import type { AdminTokenAuthService } from '../src/admin/auth/admin-token-auth.service.js';
import { ROLES_KEY } from '../src/admin/auth/roles.decorator.js';

const SECRET = 'test-admin-secret';
const jwt = new JwtService({ secret: SECRET });

/** A stand-in controller class for the ExecutionContext's `getClass()`. */
class FakeController {
  handle(): void {
    return undefined;
  }
}

function ctx(authHeader: string | undefined, requiredRoles?: string[]): ExecutionContext {
  const req = { headers: authHeader === undefined ? {} : { authorization: authHeader } } as Request;
  const handler = (): void => undefined;
  if (requiredRoles !== undefined) {
    Reflect.defineMetadata(ROLES_KEY, requiredRoles, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

/**
 * Build the guard with a fake {@link AdminTokenAuthService}. The default verifier
 * rejects every `at_` token (returns `undefined`), so the JWT-path tests — which
 * present JWTs, never `at_` tokens — never touch it and stay unaffected.
 */
function guard(tokenAuth?: Pick<AdminTokenAuthService, 'verify'>): AdminGuard {
  return new AdminGuard(
    jwt,
    new Reflector(),
    { ADMIN_JWT_SECRET: SECRET } as never,
    (tokenAuth ?? { verify: () => Promise.resolve(undefined) }) as AdminTokenAuthService,
  );
}

function tokenFor(
  claims: { sub: string; role: string },
  expiresIn?: JwtSignOptions['expiresIn'],
): string {
  return expiresIn === undefined
    ? jwt.sign(claims, { secret: SECRET })
    : jwt.sign(claims, { secret: SECRET, expiresIn });
}

describe('AdminGuard', () => {
  it('accepts a valid Bearer token and attaches admin context', async () => {
    const g = guard();
    const c = ctx(`Bearer ${tokenFor({ sub: 'admin-1', role: 'admin' })}`);
    await expect(g.canActivate(c)).resolves.toBe(true);

    const req = c.switchToHttp().getRequest<AdminRequest>();
    expect(req.admin).toMatchObject({ adminId: 'admin-1', role: 'admin' });
  });

  it('rejects a missing Authorization header', async () => {
    const g = guard();
    await expect(g.canActivate(ctx(undefined))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects a garbage token', async () => {
    const g = guard();
    await expect(g.canActivate(ctx('Bearer not.a.jwt'))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects an expired token', async () => {
    const g = guard();
    const expired = tokenFor({ sub: 'admin-1', role: 'admin' }, '-1s');
    await expect(g.canActivate(ctx(`Bearer ${expired}`))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const g = guard();
    const forged = new JwtService({ secret: 'other-secret' }).sign({ sub: 'x', role: 'admin' });
    await expect(g.canActivate(ctx(`Bearer ${forged}`))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  describe('@Roles RBAC', () => {
    it('allows when the token role satisfies the required role', async () => {
      const g = guard();
      const c = ctx(`Bearer ${tokenFor({ sub: 'a', role: 'admin' })}`, ['admin']);
      await expect(g.canActivate(c)).resolves.toBe(true);
    });

    it('denies when the token role is not in the required roles', async () => {
      const g = guard();
      const c = ctx(`Bearer ${tokenFor({ sub: 'a', role: 'viewer' })}`, ['admin']);
      await expect(g.canActivate(c)).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });

    it('allows any authenticated admin when no @Roles is set', async () => {
      const g = guard();
      const c = ctx(`Bearer ${tokenFor({ sub: 'a', role: 'viewer' })}`);
      await expect(g.canActivate(c)).resolves.toBe(true);
    });
  });

  describe('admin service token (at_ prefix) path', () => {
    it('accepts a valid service token and attaches the verifier-resolved admin context', async () => {
      const g = guard({ verify: () => Promise.resolve({ adminId: 'admin-9', role: 'admin' }) });
      const c = ctx('Bearer at_sometoken');
      await expect(g.canActivate(c)).resolves.toBe(true);

      const req = c.switchToHttp().getRequest<AdminRequest>();
      expect(req.admin).toMatchObject({ adminId: 'admin-9', role: 'admin' });
    });

    it('rejects an at_ token the verifier rejects (unknown / revoked / disabled / expired)', async () => {
      const g = guard({ verify: () => Promise.resolve(undefined) });
      await expect(g.canActivate(ctx('Bearer at_bad'))).rejects.toMatchObject({
        unified: { code: 'unauthorized' },
      });
    });

    it('routes at_ tokens to the service, NOT the JWT verifier (passes though it is not a JWT)', async () => {
      const g = guard({ verify: () => Promise.resolve({ adminId: 'a', role: 'admin' }) });
      await expect(g.canActivate(ctx('Bearer at_not-a-jwt'))).resolves.toBe(true);
    });

    it('enforces @Roles for a service token too', async () => {
      const g = guard({ verify: () => Promise.resolve({ adminId: 'a', role: 'admin' }) });
      const c = ctx('Bearer at_token', ['superadmin']);
      await expect(g.canActivate(c)).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });
  });
});
