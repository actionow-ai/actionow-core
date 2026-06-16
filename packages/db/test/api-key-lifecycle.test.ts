import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createApiKey,
  createTenant,
  disableApiKeyForTenant,
  getApiKeyForTenant,
  hashApiKey,
  rotateApiKeyForTenant,
  schema,
} from '../src/index.js';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE api_key, account, "user", tenant RESTART IDENTITY CASCADE`;
});

describe('api-key lifecycle (Track B Task 2)', () => {
  it('getApiKeyForTenant returns the row only for its owning tenant', async () => {
    const t1 = await createTenant(db, { name: 'a' });
    const t2 = await createTenant(db, { name: 'b' });
    const key = await createApiKey(db, { tenantId: t1.id });
    const mine = await getApiKeyForTenant(db, key.id, t1.id);
    expect(mine?.id).toBe(key.id);
    const theirs = await getApiKeyForTenant(db, key.id, t2.id);
    expect(theirs).toBeUndefined();
  });

  it('disableApiKeyForTenant flips status and is cross-tenant safe', async () => {
    const t1 = await createTenant(db, { name: 'c' });
    const t2 = await createTenant(db, { name: 'd' });
    const key = await createApiKey(db, { tenantId: t1.id });
    expect(await disableApiKeyForTenant(db, key.id, t2.id)).toBe(false);
    expect(await disableApiKeyForTenant(db, key.id, t1.id)).toBe(true);
    const row = await getApiKeyForTenant(db, key.id, t1.id);
    expect(row?.status).toBe('disabled');
  });

  it('rotateApiKeyForTenant mints a new active key, disables the old, preserves allowlist/rateLimit', async () => {
    const t1 = await createTenant(db, { name: 'e' });
    const old = await createApiKey(db, {
      tenantId: t1.id,
      resourceAllowlist: ['res-a'],
      rateLimit: 30,
    });
    const rotated = await rotateApiKeyForTenant(db, old.id, t1.id);
    if (rotated === undefined) throw new Error('expected rotate to succeed');
    expect(rotated.plaintext).toMatch(/^ak_/);
    expect(rotated.id).not.toBe(old.id);
    const oldRow = await getApiKeyForTenant(db, old.id, t1.id);
    expect(oldRow?.status).toBe('disabled');
    const newRow = await getApiKeyForTenant(db, rotated.id, t1.id);
    expect(newRow?.status).toBe('active');
    expect(newRow?.resourceAllowlist).toEqual(['res-a']);
    expect(newRow?.rateLimit).toBe(30);
    const looked = await db
      .select()
      .from(schema.apiKey)
      .where(eq(schema.apiKey.hash, hashApiKey(rotated.plaintext)));
    expect(looked[0]?.id).toBe(rotated.id);
  });

  it('rotateApiKeyForTenant is a cross-tenant no-op (undefined)', async () => {
    const t1 = await createTenant(db, { name: 'f' });
    const t2 = await createTenant(db, { name: 'g' });
    const old = await createApiKey(db, { tenantId: t1.id });
    expect(await rotateApiKeyForTenant(db, old.id, t2.id)).toBeUndefined();
  });
});
