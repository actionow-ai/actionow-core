import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { TokenVerifierService } from '../../auth/token-verifier.service.js';
import { engineUnauthorized } from '../../common/errors.js';
import type { AdminClaims } from './admin-auth.service.js';
import { ADMIN_TOKEN_PREFIX, AdminTokenAuthService } from './admin-token-auth.service.js';
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
 * Authenticates `/admin/*` requests via a Bearer credential — either a human
 * admin login JWT (§8, validated against `ADMIN_JWT_SECRET`) OR an `at_`-prefixed
 * admin SERVICE TOKEN (M2M; validated against the `admin_token` table). The
 * credential type is chosen by prefix so a service token is never run through the
 * JWT verifier and vice-versa. A missing, malformed, expired, revoked, or
 * wrong-secret credential is rejected with the same uniform `unauthorized`. On
 * success it attaches `{adminId, role}` to `req.admin` and — when the route
 * carries `@Roles(...)` — enforces that the role is among the required ones (for
 * both credential types).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifierService,
    private readonly reflector: Reflector,
    private readonly tokenAuth: AdminTokenAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const token = bearerToken(req);
    if (token === undefined) {
      throw engineUnauthorized('missing admin token');
    }

    const admin = token.startsWith(ADMIN_TOKEN_PREFIX)
      ? await this.tokenAuth.verify(token)
      : await this.verifyJwt(token);
    if (admin === undefined) {
      // Covers expiry, bad signature, malformed/unknown/revoked — fail closed.
      throw engineUnauthorized('invalid or expired admin token');
    }

    this.enforceRoles(context, admin.role);
    req.admin = admin;
    return true;
  }

  /**
   * Validate a human admin login JWT via the shared alg-aware verifier (RS256
   * first, then legacy HS256 when enabled); `undefined` on any failure (fail
   * closed). The `typ:'subject'` rejection below is UNCHANGED — a member token must
   * never authenticate an operator route, regardless of signing alg.
   */
  private async verifyJwt(token: string): Promise<AdminContext | undefined> {
    const claims = await this.verifier.verify(token);
    if (claims === undefined) return undefined;
    // A member (end-user) token (`typ:'subject'`, unified tenancy G-F) must NEVER
    // authenticate an operator route — reject it before any user lookup
    // (defense-in-depth, spec §5.2).
    if (claims.typ === 'subject') return undefined;
    const { sub, role } = claims as unknown as AdminClaims;
    if (typeof role !== 'string') return undefined;
    return { adminId: sub, role };
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
