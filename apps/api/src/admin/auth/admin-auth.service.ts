import type { Database, UserRecord } from '@actionow/db';
import { findUserByEmail } from '@actionow/db';
import { verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { type SessionReqMeta, SessionService, type TokenPair } from '../../auth/session.service.js';
import { TokenIssuerService } from '../../auth/token-issuer.service.js';
import { engineUnauthorized } from '../../common/errors.js';
import { DB } from '../../common/tokens.js';

/**
 * A successful admin login. ADDITIVE (auth-sessions slice): the access token is
 * accompanied by a refresh token + session. `token` is RETAINED (== accessToken)
 * so existing clients/tests keep working unchanged.
 */
export type LoginResult = TokenPair;

/** The claims embedded in an admin JWT. */
export interface AdminClaims {
  /** The admin user's id. */
  sub: string;
  /** The admin's role (e.g. `admin`), used by `@Roles` RBAC. */
  role: string;
}

/**
 * The db surface admin auth depends on. Extracted to an interface so unit tests
 * inject a fake repo with a fixed user instead of a live database.
 */
export interface AdminAuthRepo {
  findUserByEmail(db: Database, email: string): Promise<UserRecord | undefined>;
}

/** Production repo wired to the real `@actionow/db` function. */
export const defaultAdminAuthRepo: AdminAuthRepo = { findUserByEmail };

/** DI token for the (overridable) {@link AdminAuthRepo}. */
export const ADMIN_AUTH_REPO = Symbol('ADMIN_AUTH_REPO');

/**
 * Authenticates admin logins and mints JWTs (§8, repointed to the unified `user`
 * model in Phase 9). Looks the user up by email, requires `role==='admin'` and
 * an active account, verifies the password against its scrypt hash in constant
 * time, and — on success — signs a `{sub, role}` JWT with `ADMIN_JWT_SECRET`.
 * Every failure (unknown email, non-admin role, disabled account, wrong/absent
 * password) returns the SAME `unauthorized` error so the response can't be used
 * to enumerate admins.
 *
 * Neither the password nor the JWT secret is ever logged.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADMIN_AUTH_REPO) private readonly repo: AdminAuthRepo,
    private readonly issuer: TokenIssuerService,
    private readonly sessions: SessionService,
  ) {}

  async login(email: string, password: string, meta?: SessionReqMeta): Promise<LoginResult> {
    const user = await this.repo.findUserByEmail(this.db, email);
    // Uniform rejection regardless of which check fails (no user enumeration):
    // must be an active admin with a local password that verifies.
    if (
      user?.status !== 'active' ||
      user.role !== 'admin' ||
      user.passwordHash === null ||
      !verifyPassword(user.passwordHash, password)
    ) {
      throw engineUnauthorized('invalid credentials');
    }

    // The admin login is a `user` row with role='admin'; the access token keeps the
    // `{sub, role}` shape, but the session is `principal_kind='admin'` so a refresh
    // re-mints the admin role and gates the admin plane again.
    const accessToken = await this.issuer.issueAccess({
      sub: user.id,
      role: user.role,
    } satisfies AdminClaims);
    return this.sessions.createForPrincipal(
      { principalKind: 'admin', id: user.id, role: user.role, tenantId: user.tenantId },
      accessToken,
      meta ?? {},
    );
  }
}
