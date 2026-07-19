import type {
  CreateSubjectInput,
  CreateUserInput,
  Database,
  SubjectRow,
  UserRecord,
} from '@actionow/db';
import {
  createAccount,
  createSubject,
  createTenant,
  createUser,
  findSubjectByEmail,
  findUserByEmail,
} from '@actionow/db';
import { hashPassword, verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import type { SessionReqMeta, TokenPair } from './session.service.js';
import { SessionService } from './session.service.js';
import { TokenIssuerService } from './token-issuer.service.js';

/**
 * A successful register/login. ADDITIVE (auth-sessions slice): the signed access
 * token is now accompanied by a refresh token + the matching session. `token` is
 * RETAINED (and always equals `accessToken`) so existing clients/tests/apps-web
 * keep working unchanged.
 */
export type AuthResult = TokenPair;

/** The `{sub, role}` claims embedded in every issued JWT (admin + user share). */
export interface AuthClaims {
  /** The user's id. */
  sub: string;
  /** The user's role (`user` | `admin`), used by `@Roles` RBAC. */
  role: string;
}

/** Credentials for {@link LocalAuthService.register} / `.login`. */
export interface Credentials {
  email: string;
  password: string;
}

/** Member (end-user) credentials — a tenant-scoped login (unified tenancy G-F). */
export interface MemberCredentials {
  email: string;
  password: string;
  tenantId: string;
}

/**
 * The claims in a MEMBER (end-user) JWT. `typ:'subject'` distinguishes it from an
 * operator token so the Admin/Console guards reject it (spec §5.2); `sub` is the
 * subject id and `tenant_id` scopes it to one tenant.
 */
export interface MemberClaims {
  sub: string;
  tenant_id: string;
  typ: 'subject';
}

/**
 * The db surface the unified auth service depends on. Extracted to an interface
 * so unit tests inject a fake repo instead of a live database. Mirrors the
 * `@actionow/db` function signatures.
 */
export interface LocalAuthRepo {
  findUserByEmail(db: Database, email: string): Promise<UserRecord | undefined>;
  createUser(db: Database, input: CreateUserInput): Promise<UserRecord>;
  createTenant(db: Database, input: { name: string }): Promise<{ id: string }>;
  createAccount(db: Database, input: { tenantId: string }): Promise<{ id: string }>;
  findSubjectByEmail(
    db: Database,
    tenantId: string,
    email: string,
  ): Promise<SubjectRow | undefined>;
  createSubject(db: Database, input: CreateSubjectInput): Promise<SubjectRow>;
}

/** Production repo wired to the real `@actionow/db` functions. */
export const defaultLocalAuthRepo: LocalAuthRepo = {
  findUserByEmail,
  createUser,
  createTenant: (db, input) => createTenant(db, input),
  createAccount: (db, input) => createAccount(db, input),
  findSubjectByEmail,
  createSubject,
};

/** DI token for the (overridable) {@link LocalAuthRepo}. */
export const LOCAL_AUTH_REPO = Symbol('LOCAL_AUTH_REPO');

/**
 * Unified local authentication (Phase 9). `register` provisions a fresh
 * tenant+account for a new self-serve user and mints a `{sub, role}` JWT;
 * `login` verifies the scrypt password in constant time and returns the SAME
 * `unauthorized` error on every failure (no user enumeration). `issueToken` is
 * the shared signer reused by the admin login repoint (and, in Task 3, OAuth).
 *
 * Neither the password nor the JWT secret is ever logged.
 */
@Injectable()
export class LocalAuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(LOCAL_AUTH_REPO) private readonly repo: LocalAuthRepo,
    private readonly issuer: TokenIssuerService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Register a new local user: reject a duplicate email, hash the password,
   * provision a tenant+account, persist the user with that tenant, and return a
   * freshly-signed JWT.
   */
  async register(creds: Credentials, meta?: SessionReqMeta): Promise<AuthResult> {
    const existing = await this.repo.findUserByEmail(this.db, creds.email);
    if (existing !== undefined) {
      throw engineInvalidInput('email already registered');
    }

    // Provision the tenant + its billing account up-front so the new user is
    // created already pointing at its tenant (no follow-up update needed).
    const tenant = await this.repo.createTenant(this.db, { name: `user-${creds.email}` });
    await this.repo.createAccount(this.db, { tenantId: tenant.id });

    const user = await this.repo.createUser(this.db, {
      email: creds.email,
      passwordHash: hashPassword(creds.password),
      role: 'user',
      tenantRole: 'admin', // a tenant creator owns its tenant — full /app control (rbac)
      emailVerified: false,
      tenantId: tenant.id,
    });

    return this.issueToken(user, meta);
  }

  /**
   * Authenticate an existing local user. Returns the uniform `unauthorized`
   * error for an unknown email, a disabled account, a password-less (OAuth-only)
   * account, or a wrong password — so the response can't enumerate users.
   */
  async login(creds: Credentials, meta?: SessionReqMeta): Promise<AuthResult> {
    const user = await this.repo.findUserByEmail(this.db, creds.email);
    if (
      user?.status !== 'active' ||
      user.passwordHash === null ||
      !verifyPassword(user.passwordHash, creds.password)
    ) {
      throw engineUnauthorized('invalid credentials');
    }
    return this.issueToken(user, meta);
  }

  /**
   * Sign a `{sub, role}` access token for a user AND open a login session (shared
   * by register/login + OAuth). The access token is signed by the alg-aware
   * {@link TokenIssuerService}; the {@link SessionService} mints the paired refresh
   * token. Returns the additive `{token, accessToken, refreshToken, expiresIn}`.
   *
   * The session's `principal_kind` MUST track the user's plane: a platform admin
   * (`role='admin'`) opens an `admin` session, a tenant operator (`role='user'`)
   * a `user` session. `principal_kind` — NOT the (unstored) role — is what
   * {@link SessionService.refresh} re-mints the access role from, so hard-coding
   * `'user'` here would silently downgrade a refreshed admin token to `role:'user'`.
   */
  async issueToken(
    user: Pick<UserRecord, 'id' | 'role'>,
    meta?: SessionReqMeta,
  ): Promise<AuthResult> {
    const accessToken = await this.issuer.issueAccess({ sub: user.id, role: user.role });
    const principalKind = user.role === 'admin' ? 'admin' : 'user';
    return this.sessions.createForPrincipal(
      { principalKind, id: user.id, role: user.role },
      accessToken,
      meta ?? {},
    );
  }

  /**
   * Register a MEMBER (end-user) under an EXISTING tenant (Model-A; unified
   * tenancy G-F) — creates a `subject` (NOT a tenant, unlike {@link register}),
   * rejecting a duplicate email within that tenant, and returns a member JWT.
   */
  async registerMember(creds: MemberCredentials, meta?: SessionReqMeta): Promise<AuthResult> {
    const existing = await this.repo.findSubjectByEmail(this.db, creds.tenantId, creds.email);
    if (existing !== undefined) {
      throw engineInvalidInput('email already registered for this tenant');
    }
    let subject: SubjectRow;
    try {
      subject = await this.repo.createSubject(this.db, {
        tenantId: creds.tenantId,
        email: creds.email,
        passwordHash: hashPassword(creds.password),
      });
    } catch {
      // The only expected failure here is the tenant FK (unknown tenant); surface
      // a clean 400 rather than a 500.
      throw engineInvalidInput('unknown tenant');
    }
    return this.issueMemberToken(subject, meta);
  }

  /**
   * Authenticate a MEMBER by `(tenant, email, password)`. Uniform `unauthorized`
   * for an unknown email, disabled/credential-less subject, or wrong password.
   */
  async loginMember(creds: MemberCredentials, meta?: SessionReqMeta): Promise<AuthResult> {
    const subject = await this.repo.findSubjectByEmail(this.db, creds.tenantId, creds.email);
    if (
      subject?.status !== 'active' ||
      subject.passwordHash === null ||
      !verifyPassword(subject.passwordHash, creds.password)
    ) {
      throw engineUnauthorized('invalid credentials');
    }
    return this.issueMemberToken(subject, meta);
  }

  /**
   * Sign a member (end-user) access token carrying `typ:'subject'` (rejected by
   * operator guards) AND open a `subject` login session. Returns the additive
   * token pair; the re-minted token on refresh keeps `typ:'subject'` + tenant_id.
   */
  async issueMemberToken(
    subject: Pick<SubjectRow, 'id' | 'tenantId'>,
    meta?: SessionReqMeta,
  ): Promise<AuthResult> {
    const accessToken = await this.issuer.issueAccess({
      sub: subject.id,
      tenant_id: subject.tenantId,
      typ: 'subject',
    } satisfies MemberClaims);
    return this.sessions.createForPrincipal(
      { principalKind: 'subject', id: subject.id, tenantId: subject.tenantId },
      accessToken,
      meta ?? {},
    );
  }
}
