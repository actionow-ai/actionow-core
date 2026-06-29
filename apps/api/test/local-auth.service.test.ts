import type {
  CreateSubjectInput,
  CreateUserInput,
  Database,
  SubjectRow,
  UserRecord,
} from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LocalAuthRepo } from '../src/auth/local-auth.service.js';
import { LocalAuthService } from '../src/auth/local-auth.service.js';
import type { SessionPrincipal, SessionReqMeta, TokenPair } from '../src/auth/session.service.js';
import type { SessionService } from '../src/auth/session.service.js';
import { TokenIssuerService } from '../src/auth/token-issuer.service.js';

const SECRET = 'test-auth-secret';

/** A real HS256 issuer (no RS256 keys) — the default-env path. */
function issuer(): TokenIssuerService {
  return new TokenIssuerService(
    { ADMIN_JWT_SECRET: SECRET, JWT_SIGNING_ALG: 'HS256', JWT_ACCESS_TTL: '12h' } as never,
    new JwtService({ secret: SECRET }),
    null,
  );
}

/**
 * A stub SessionService that skips the DB: it just wraps the already-minted access
 * token into the additive pair, with a deterministic refresh token. The session
 * REPO's own persistence is covered by the db int test.
 */
class FakeSessions {
  readonly created: SessionPrincipal[] = [];
  readonly metas: (SessionReqMeta | undefined)[] = [];
  createForPrincipal(
    principal: SessionPrincipal,
    accessToken: string,
    meta?: SessionReqMeta,
  ): Promise<TokenPair> {
    this.created.push(principal);
    this.metas.push(meta);
    return Promise.resolve({
      token: accessToken,
      accessToken,
      refreshToken: 'rt_fake',
      expiresIn: '12h',
    });
  }
}

/** An in-memory fake of the db surface the service uses. */
class FakeRepo implements LocalAuthRepo {
  readonly users: UserRecord[] = [];
  readonly tenants: string[] = [];
  readonly accounts: { tenantId: string }[] = [];
  private seq = 0;

  findUserByEmail(_db: Database, email: string): Promise<UserRecord | undefined> {
    const norm = email.trim().toLowerCase();
    return Promise.resolve(this.users.find((u) => u.email === norm));
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq)}`;
  }

  createUser(_db: Database, input: CreateUserInput): Promise<UserRecord> {
    const user: UserRecord = {
      id: this.nextId('user'),
      email: input.email.trim().toLowerCase(),
      emailVerified: input.emailVerified ?? false,
      passwordHash: input.passwordHash ?? null,
      role: input.role ?? 'user',
      tenantRole: input.tenantRole ?? null,
      status: input.status ?? 'active',
      tenantId: input.tenantId ?? null,
      createdAt: new Date(),
    };
    this.users.push(user);
    return Promise.resolve(user);
  }

  createTenant(_db: Database, input: { name: string }): Promise<{ id: string }> {
    const id = this.nextId('tenant');
    this.tenants.push(input.name);
    return Promise.resolve({ id });
  }

  createAccount(_db: Database, input: { tenantId: string }): Promise<{ id: string }> {
    this.accounts.push({ tenantId: input.tenantId });
    return Promise.resolve({ id: this.nextId('acct') });
  }

  readonly subjects: SubjectRow[] = [];

  findSubjectByEmail(
    _db: Database,
    tenantId: string,
    email: string,
  ): Promise<SubjectRow | undefined> {
    const norm = email.trim().toLowerCase();
    return Promise.resolve(
      this.subjects.find(
        (s) => s.tenantId === tenantId && s.email === norm && s.deletedAt === null,
      ),
    );
  }

  createSubject(_db: Database, input: CreateSubjectInput): Promise<SubjectRow> {
    // model the tenant FK: an unknown tenant id rejects (→ registerMember 400).
    if (input.tenantId === 'bad') return Promise.reject(new Error('tenant fk violation'));
    const s: SubjectRow = {
      id: this.nextId('subject'),
      tenantId: input.tenantId,
      externalId: input.externalId ?? null,
      email: input.email != null ? input.email.trim().toLowerCase() : null,
      passwordHash: input.passwordHash ?? null,
      displayName: input.displayName ?? null,
      limitPlanId: input.limitPlanId ?? null,
      status: input.status ?? 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    this.subjects.push(s);
    return Promise.resolve(s);
  }
}

function service(repo: LocalAuthRepo): LocalAuthService {
  return new LocalAuthService(
    {} as Database,
    repo,
    issuer(),
    new FakeSessions() as unknown as SessionService,
  );
}

function claimsOf(token: string): { sub: string; role: string } {
  return new JwtService({ secret: SECRET }).verify<{ sub: string; role: string }>(token);
}

function memberClaimsOf(token: string): { sub: string; tenant_id: string; typ: string } {
  return new JwtService({ secret: SECRET }).verify<{ sub: string; tenant_id: string; typ: string }>(
    token,
  );
}

let repo: FakeRepo;

beforeEach(() => {
  repo = new FakeRepo();
});

describe('LocalAuthService.register', () => {
  it('creates a role=user, unverified, password-hashed user + provisions tenant/account', async () => {
    const { token } = await service(repo).register({
      email: 'New@Example.com',
      password: 'hunter2',
    });

    const claims = claimsOf(token);
    expect(claims.role).toBe('user');

    const user = repo.users[0];
    expect(user?.email).toBe('new@example.com');
    expect(user?.role).toBe('user');
    expect(user?.tenantRole).toBe('admin'); // a tenant creator is its tenant admin (rbac)
    expect(user?.emailVerified).toBe(false);
    expect(user?.passwordHash).not.toBeNull();
    expect(user?.tenantId).toBeTypeOf('string');

    // Exactly one tenant + one account provisioned, the account on the tenant.
    expect(repo.tenants).toHaveLength(1);
    expect(repo.accounts).toHaveLength(1);
    expect(repo.accounts[0]?.tenantId).toBe(user?.tenantId);
  });

  it('does not store the plaintext password', async () => {
    await service(repo).register({ email: 'p@example.com', password: 'plaintext-secret' });
    expect(repo.users[0]?.passwordHash).not.toContain('plaintext-secret');
  });

  it('rejects a duplicate email with invalid_input and provisions nothing', async () => {
    await service(repo).register({ email: 'dup@example.com', password: 'hunter2' });
    await expect(
      service(repo).register({ email: 'DUP@example.com', password: 'other' }),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
    // No second tenant/account from the failed duplicate.
    expect(repo.tenants).toHaveLength(1);
    expect(repo.accounts).toHaveLength(1);
  });
});

describe('LocalAuthService.login', () => {
  it('returns a token for correct credentials', async () => {
    await service(repo).register({ email: 'login@example.com', password: 'right' });
    const { token } = await service(repo).login({ email: 'LOGIN@example.com', password: 'right' });
    expect(claimsOf(token).role).toBe('user');
  });

  it('rejects a wrong password with uniform unauthorized', async () => {
    await service(repo).register({ email: 'login@example.com', password: 'right' });
    await expect(
      service(repo).login({ email: 'login@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects an unknown email with uniform unauthorized (no enumeration)', async () => {
    await expect(
      service(repo).login({ email: 'nobody@example.com', password: 'x' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects an OAuth-only account (null password) with unauthorized', async () => {
    await repo.createUser({} as Database, { email: 'oauth@example.com', passwordHash: null });
    await expect(
      service(repo).login({ email: 'oauth@example.com', password: 'anything' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects a disabled account with unauthorized', async () => {
    repo.users.push({
      id: 'u-disabled',
      email: 'disabled@example.com',
      emailVerified: true,
      passwordHash: hashPassword('right'),
      role: 'user',
      tenantRole: 'admin',
      status: 'disabled',
      tenantId: null,
      createdAt: new Date(),
    });
    await expect(
      service(repo).login({ email: 'disabled@example.com', password: 'right' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });
});

describe('LocalAuthService.registerMember / loginMember (G-F)', () => {
  it('registers a member as a subject + issues a typ:subject token (no new tenant)', async () => {
    const { token } = await service(repo).registerMember({
      email: 'M@x.com',
      password: 'hunter2',
      tenantId: 'tenant-1',
    });
    const claims = memberClaimsOf(token);
    expect(claims.typ).toBe('subject');
    expect(claims.tenant_id).toBe('tenant-1');
    expect(repo.subjects[0]?.email).toBe('m@x.com');
    expect(repo.subjects[0]?.passwordHash).not.toBeNull();
    expect(repo.tenants).toHaveLength(0); // unlike register(), no tenant provisioned
  });

  it('rejects a duplicate member email within the tenant', async () => {
    await service(repo).registerMember({ email: 'dup@x.com', password: 'hunter2', tenantId: 't1' });
    await expect(
      service(repo).registerMember({ email: 'DUP@x.com', password: 'other', tenantId: 't1' }),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
  });

  it('maps an unknown tenant to invalid_input', async () => {
    await expect(
      service(repo).registerMember({ email: 'x@x.com', password: 'hunter2', tenantId: 'bad' }),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
  });

  it('loginMember authenticates per-tenant; wrong password or wrong tenant → unauthorized', async () => {
    await service(repo).registerMember({ email: 'login@x.com', password: 'right', tenantId: 't1' });
    const { token } = await service(repo).loginMember({
      email: 'login@x.com',
      password: 'right',
      tenantId: 't1',
    });
    expect(memberClaimsOf(token).typ).toBe('subject');

    await expect(
      service(repo).loginMember({ email: 'login@x.com', password: 'wrong', tenantId: 't1' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    // right creds but the wrong tenant must not authenticate (tenant-scoped).
    await expect(
      service(repo).loginMember({ email: 'login@x.com', password: 'right', tenantId: 't2' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });
});
