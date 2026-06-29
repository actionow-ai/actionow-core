import type { Database, UserRecord } from '@actionow/db';
import { findUserById, getAccountByTenant } from '@actionow/db';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthClaims } from '../auth/local-auth.service.js';
import { TokenVerifierService } from '../auth/token-verifier.service.js';
import { engineUnauthorized } from '../common/errors.js';
import { DB } from '../common/tokens.js';

/** The authenticated tenant-console context the guard attaches as `req.console`. */
export interface ConsoleContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly accountId: string;
  /** The operator's seat level in their tenant — `'admin'` or `'member'`. */
  readonly tenantRole: string;
}

/** An express request carrying the guard-populated {@link ConsoleContext}. */
export interface ConsoleRequest extends Request {
  console?: ConsoleContext;
}

/**
 * The db surface {@link ConsoleGuard} depends on. Extracted to an interface so
 * unit tests inject a fake repo instead of a live database. Mirrors the
 * `@actionow/db` function signatures.
 */
export interface ConsoleRepo {
  findUserById(db: Database, id: string): Promise<UserRecord | undefined>;
  getAccountByTenant(db: Database, tenantId: string): Promise<{ id: string } | undefined>;
}

/** Production repo wired to the real `@actionow/db` functions. */
export const defaultConsoleRepo: ConsoleRepo = { findUserById, getAccountByTenant };

/** DI token for the (overridable) {@link ConsoleRepo}. */
export const CONSOLE_REPO = Symbol('CONSOLE_REPO');

/**
 * Authenticates the tenant self-service console plane via the USER JWT (the same
 * `{sub, role}` claims signed against `ADMIN_JWT_SECRET` by
 * `LocalAuthService.issueToken`). Verifies the Bearer token, loads the user by
 * `sub`, and requires an `active` user with a non-null `tenant_id` whose tenant
 * resolves to a billing account. On success it attaches
 * `{userId, tenantId, accountId}` to `req.console`. Any missing/expired/forged
 * token, a non-active or tenant-less user, or a tenant without an account fails
 * closed with `unauthorized`. Independent of the `ApiKeyGuard` data plane.
 */
@Injectable()
export class ConsoleGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifierService,
    @Inject(DB) private readonly db: Database,
    @Inject(CONSOLE_REPO) private readonly repo: ConsoleRepo,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ConsoleRequest>();
    const token = bearerToken(req);
    if (token === undefined) {
      throw engineUnauthorized('missing console token');
    }

    // The shared alg-aware verifier (RS256 first, then legacy HS256). `undefined`
    // covers expiry/bad signature/malformed — fail closed.
    const verified = await this.verifier.verify(token);
    if (verified === undefined) {
      throw engineUnauthorized('invalid or expired console token');
    }
    const claims = verified as unknown as AuthClaims & { typ?: string };
    // A member (end-user) token (`typ:'subject'`, unified tenancy G-F) is NOT an
    // operator console token — reject it before any user lookup (spec §5.2). The
    // end-user console (G-F) authenticates members on its own dedicated path.
    if (claims.typ === 'subject') {
      throw engineUnauthorized('member tokens cannot access the operator console');
    }

    const user = await this.repo.findUserById(this.db, claims.sub);
    if (user?.status !== 'active' || user.tenantId === null) {
      throw engineUnauthorized('no tenant for console user');
    }

    const account = await this.repo.getAccountByTenant(this.db, user.tenantId);
    if (account === undefined) {
      throw engineUnauthorized(`no account for tenant ${user.tenantId}`);
    }

    req.console = {
      userId: user.id,
      tenantId: user.tenantId,
      accountId: account.id,
      // DB-resolved (Path A): never signed into the JWT. `?? 'admin'` is a
      // belt-and-suspenders default — after the rbac backfill every `role='user'`
      // row has a non-null `tenant_role`.
      tenantRole: user.tenantRole ?? 'admin',
    };
    return true;
  }
}

/** Read a Bearer token from the `Authorization` header. */
function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1];
}
