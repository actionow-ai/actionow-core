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
import type { AppEnv } from '@actionow/infra';
import { hashPassword, verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';

/** A successful register/login: the signed JWT. */
export interface AuthResult {
  token: string;
}

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

/** Token lifetime: re-auth daily (mirrors the admin login TTL). */
const TOKEN_TTL = '12h';

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
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  /**
   * Register a new local user: reject a duplicate email, hash the password,
   * provision a tenant+account, persist the user with that tenant, and return a
   * freshly-signed JWT.
   */
  async register(creds: Credentials): Promise<AuthResult> {
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
      emailVerified: false,
      tenantId: tenant.id,
    });

    return this.issueToken(user);
  }

  /**
   * Authenticate an existing local user. Returns the uniform `unauthorized`
   * error for an unknown email, a disabled account, a password-less (OAuth-only)
   * account, or a wrong password — so the response can't enumerate users.
   */
  async login(creds: Credentials): Promise<AuthResult> {
    const user = await this.repo.findUserByEmail(this.db, creds.email);
    if (
      user?.status !== 'active' ||
      user.passwordHash === null ||
      !verifyPassword(user.passwordHash, creds.password)
    ) {
      throw engineUnauthorized('invalid credentials');
    }
    return this.issueToken(user);
  }

  /** Sign a `{sub, role}` JWT for a user (shared by register/login + OAuth). */
  async issueToken(user: Pick<UserRecord, 'id' | 'role'>): Promise<AuthResult> {
    const claims: AuthClaims = { sub: user.id, role: user.role };
    const token = await this.jwt.signAsync(claims, {
      secret: this.env.ADMIN_JWT_SECRET,
      expiresIn: TOKEN_TTL,
    });
    return { token };
  }

  /**
   * Register a MEMBER (end-user) under an EXISTING tenant (Model-A; unified
   * tenancy G-F) — creates a `subject` (NOT a tenant, unlike {@link register}),
   * rejecting a duplicate email within that tenant, and returns a member JWT.
   */
  async registerMember(creds: MemberCredentials): Promise<AuthResult> {
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
    return this.issueMemberToken(subject);
  }

  /**
   * Authenticate a MEMBER by `(tenant, email, password)`. Uniform `unauthorized`
   * for an unknown email, disabled/credential-less subject, or wrong password.
   */
  async loginMember(creds: MemberCredentials): Promise<AuthResult> {
    const subject = await this.repo.findSubjectByEmail(this.db, creds.tenantId, creds.email);
    if (
      subject?.status !== 'active' ||
      subject.passwordHash === null ||
      !verifyPassword(subject.passwordHash, creds.password)
    ) {
      throw engineUnauthorized('invalid credentials');
    }
    return this.issueMemberToken(subject);
  }

  /** Sign a member (end-user) JWT carrying `typ:'subject'` (rejected by operator guards). */
  async issueMemberToken(subject: Pick<SubjectRow, 'id' | 'tenantId'>): Promise<AuthResult> {
    const claims: MemberClaims = { sub: subject.id, tenant_id: subject.tenantId, typ: 'subject' };
    const token = await this.jwt.signAsync(claims, {
      secret: this.env.ADMIN_JWT_SECRET,
      expiresIn: TOKEN_TTL,
    });
    return { token };
  }
}
