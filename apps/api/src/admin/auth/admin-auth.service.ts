import type { Database, UserRecord } from '@actionow/db';
import { findUserByEmail } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { engineUnauthorized } from '../../common/errors.js';
import { DB, ENV } from '../../common/tokens.js';

/** A successful login: the signed admin JWT. */
export interface LoginResult {
  token: string;
}

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

/** Token lifetime: admins re-auth daily. */
const TOKEN_TTL = '12h';

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
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
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

    const claims: AdminClaims = { sub: user.id, role: user.role };
    const token = await this.jwt.signAsync(claims, {
      secret: this.env.ADMIN_JWT_SECRET,
      expiresIn: TOKEN_TTL,
    });
    return { token };
  }
}
