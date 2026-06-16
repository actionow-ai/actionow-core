import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createApiKey,
  createUser,
  createUserIdentity,
  findApiKeyByHash,
  findUserByEmail,
  findUserById,
  findUserByIdentity,
  linkIdentityTx,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE api_key, user_identity, "user", account, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('createApiKey', () => {
  it('returns a plaintext ak_ key and stores only its sha256 hash', async () => {
    const tenantId = await makeTenant();

    const { id, plaintext } = await createApiKey(db, { tenantId });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plaintext).toMatch(/^ak_[A-Za-z0-9_-]+$/);

    // The stored hash is sha256(plaintext) hex — the plaintext is never stored.
    const expectedHash = createHash('sha256').update(plaintext).digest('hex');
    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, id));
    expect(row?.hash).toBe(expectedHash);
    expect(row?.hash).not.toContain(plaintext);
  });

  it('persists resourceAllowlist and rateLimit when provided', async () => {
    const tenantId = await makeTenant();

    const { plaintext } = await createApiKey(db, {
      tenantId,
      resourceAllowlist: ['openai-gpt', 'anthropic-claude'],
      rateLimit: 120,
    });

    const hash = createHash('sha256').update(plaintext).digest('hex');
    const found = await findApiKeyByHash(db, hash);
    expect(found?.resourceAllowlist).toEqual(['openai-gpt', 'anthropic-claude']);
    expect(found?.rateLimit).toBe(120);
  });

  it('generates distinct plaintext keys on each call', async () => {
    const tenantId = await makeTenant();
    const a = await createApiKey(db, { tenantId });
    const b = await createApiKey(db, { tenantId });
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe('findApiKeyByHash', () => {
  it('round-trips a created key by its sha256 hash', async () => {
    const tenantId = await makeTenant();
    const { id, plaintext } = await createApiKey(db, { tenantId });
    const hash = createHash('sha256').update(plaintext).digest('hex');

    const found = await findApiKeyByHash(db, hash);

    expect(found).toBeDefined();
    expect(found?.id).toBe(id);
    expect(found?.tenantId).toBe(tenantId);
    expect(found?.status).toBe('active');
    expect(found?.resourceAllowlist).toEqual([]);
    expect(found?.rateLimit).toBeNull();
  });

  it('returns undefined for an unknown hash', async () => {
    const found = await findApiKeyByHash(db, 'deadbeef');
    expect(found).toBeUndefined();
  });
});

describe('createUser / findUserByEmail / findUserById', () => {
  it('creates a user and finds it by id and by (lowercased) email', async () => {
    const created = await createUser(db, {
      email: 'admin@actionow.local',
      passwordHash: 'scrypt$aa$bb',
      role: 'admin',
      emailVerified: true,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.email).toBe('admin@actionow.local');
    expect(created.role).toBe('admin');
    expect(created.emailVerified).toBe(true);
    expect(created.status).toBe('active');
    expect(created.tenantId).toBeNull();

    const byEmail = await findUserByEmail(db, 'admin@actionow.local');
    expect(byEmail?.id).toBe(created.id);
    expect(byEmail?.passwordHash).toBe('scrypt$aa$bb');

    const byId = await findUserById(db, created.id);
    expect(byId?.email).toBe('admin@actionow.local');
  });

  it('normalizes email to lowercase on write and lookup (case-insensitive)', async () => {
    const created = await createUser(db, {
      email: 'MixedCase@Actionow.Local',
      passwordHash: 'scrypt$aa$bb',
      role: 'user',
    });
    // Stored lowercase.
    expect(created.email).toBe('mixedcase@actionow.local');

    // Lookup with any casing resolves the same row.
    const a = await findUserByEmail(db, 'mixedcase@actionow.local');
    const b = await findUserByEmail(db, 'MIXEDCASE@ACTIONOW.LOCAL');
    expect(a?.id).toBe(created.id);
    expect(b?.id).toBe(created.id);
  });

  it('defaults role=user, status=active, emailVerified=false, passwordHash null', async () => {
    const created = await createUser(db, { email: 'plain@actionow.local' });
    expect(created.role).toBe('user');
    expect(created.status).toBe('active');
    expect(created.emailVerified).toBe(false);
    expect(created.passwordHash).toBeNull();
  });

  it('records tenantId when provided', async () => {
    const tenantId = await makeTenant();
    const created = await createUser(db, { email: 't@actionow.local', tenantId });
    expect(created.tenantId).toBe(tenantId);
  });

  it('returns undefined for an unknown email / id', async () => {
    expect(await findUserByEmail(db, 'nobody@actionow.local')).toBeUndefined();
    expect(await findUserById(db, '00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('user_identity (createUserIdentity / findUserByIdentity / linkIdentityTx)', () => {
  it('links an identity and resolves the user via the join', async () => {
    const created = await createUser(db, { email: 'oauth@actionow.local' });
    await createUserIdentity(db, {
      userId: created.id,
      provider: 'google',
      providerUserId: 'google-sub-123',
    });

    const found = await findUserByIdentity(db, 'google', 'google-sub-123');
    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe('oauth@actionow.local');
  });

  it('returns undefined for an unknown (provider, sub)', async () => {
    const found = await findUserByIdentity(db, 'github', 'nope');
    expect(found).toBeUndefined();
  });

  it('rejects a duplicate (provider, provider_user_id)', async () => {
    const a = await createUser(db, { email: 'a@actionow.local' });
    const b = await createUser(db, { email: 'b@actionow.local' });
    await createUserIdentity(db, { userId: a.id, provider: 'github', providerUserId: 'gh-1' });

    await expect(
      createUserIdentity(db, { userId: b.id, provider: 'github', providerUserId: 'gh-1' }),
    ).rejects.toThrow();
  });

  it('linkIdentityTx creates a user + identity atomically', async () => {
    const user = await linkIdentityTx(db, {
      email: 'fresh@actionow.local',
      role: 'user',
      emailVerified: true,
      provider: 'google',
      providerUserId: 'g-fresh',
    });
    expect(user.email).toBe('fresh@actionow.local');

    const found = await findUserByIdentity(db, 'google', 'g-fresh');
    expect(found?.id).toBe(user.id);
  });
});
