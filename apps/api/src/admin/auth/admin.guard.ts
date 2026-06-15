import type { AppEnv } from '@actionow/infra';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { engineUnauthorized } from '../../common/errors.js';
import { ENV } from '../../common/tokens.js';
import type { AdminClaims } from './admin-auth.service.js';
import { ROLES_KEY } from './roles.decorator.js';

/** The authenticated admin context the guard attaches as `req.admin`. */
export interface AdminContext {
  adminId: string;
  role: string;
}

/** An express request carrying the guard-populated {@link AdminContext}. */
export interface AdminRequest extends Request {
  admin?: AdminContext;
}

/**
 * Authenticates `/admin/*` requests via a Bearer JWT (§8). Validates the token
 * against `ADMIN_JWT_SECRET`, rejecting a missing, malformed, expired, or
 * wrong-secret token with `unauthorized`. On success it attaches
 * `{adminId, role}` to `req.admin` and — when the route carries `@Roles(...)` —
 * enforces that the admin's role is among the required ones.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const token = bearerToken(req);
    if (token === undefined) {
      throw engineUnauthorized('missing admin token');
    }

    let claims: AdminClaims;
    try {
      claims = await this.jwt.verifyAsync<AdminClaims>(token, {
        secret: this.env.ADMIN_JWT_SECRET,
      });
    } catch {
      // Covers expiry, bad signature, and malformed tokens — fail closed.
      throw engineUnauthorized('invalid or expired admin token');
    }

    this.enforceRoles(context, claims.role);
    req.admin = { adminId: claims.sub, role: claims.role };
    return true;
  }

  /** Enforce a route's `@Roles(...)` requirement (no metadata → any admin). */
  private enforceRoles(context: ExecutionContext, role: string): void {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return;
    if (!required.includes(role)) {
      throw engineUnauthorized('insufficient admin role');
    }
  }
}

/** Read a Bearer token from the `Authorization` header. */
function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1];
}
