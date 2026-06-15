import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createAdminUser,
  createApiKey,
  findAdminByEmail,
  findApiKeyByHash,
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
  await client`TRUNCATE TABLE api_key, admin_user, account, tenant RESTART IDENTITY CASCADE`;
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

describe('admin users', () => {
  it('creates an admin and finds it by email', async () => {
    const created = await createAdminUser(db, {
      email: 'admin@actionow.local',
      passwordHash: 'scrypt$aa$bb',
      role: 'admin',
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const found = await findAdminByEmail(db, 'admin@actionow.local');
    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe('admin@actionow.local');
    expect(found?.passwordHash).toBe('scrypt$aa$bb');
    expect(found?.role).toBe('admin');
    expect(found?.status).toBe('active');
  });

  it('returns undefined for an unknown email', async () => {
    const found = await findAdminByEmail(db, 'nobody@actionow.local');
    expect(found).toBeUndefined();
  });
});
