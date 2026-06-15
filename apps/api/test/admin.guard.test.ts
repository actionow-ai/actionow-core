import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import type { AdminRequest } from '../src/admin/auth/admin.guard.js';
import { AdminGuard } from '../src/admin/auth/admin.guard.js';
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

function guard(): AdminGuard {
  return new AdminGuard(jwt, new Reflector(), { ADMIN_JWT_SECRET: SECRET } as never);
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
});
