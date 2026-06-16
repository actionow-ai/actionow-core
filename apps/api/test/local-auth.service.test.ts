import type { CreateUserInput, Database, UserRecord } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LocalAuthRepo } from '../src/auth/local-auth.service.js';
import { LocalAuthService } from '../src/auth/local-auth.service.js';

const SECRET = 'test-auth-secret';

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
      status: input.status ?? 'active',
      tenantId: input.tenantId ?? null,
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
}

function service(repo: LocalAuthRepo): LocalAuthService {
  return new LocalAuthService({} as Database, repo, new JwtService({ secret: SECRET }), {
    ADMIN_JWT_SECRET: SECRET,
  } as never);
}

function claimsOf(token: string): { sub: string; role: string } {
  return new JwtService({ secret: SECRET }).verify<{ sub: string; role: string }>(token);
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
      status: 'disabled',
      tenantId: null,
    });
    await expect(
      service(repo).login({ email: 'disabled@example.com', password: 'right' }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });
});
