import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createAdminToken,
  createUser,
  findAdminTokenByHash,
  listAdminTokens,
  softDeleteAdminToken,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

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
  await client`TRUNCATE TABLE admin_token, "user", tenant RESTART IDENTITY CASCADE`;
});

async function makeAdmin(): Promise<string> {
  const u = await createUser(db, {
    email: 'admin@actionow.local',
    role: 'admin',
    passwordHash: 'scrypt$a$b',
  });
  return u.id;
}

describe('createAdminToken', () => {
  it('returns a plaintext at_ token and stores only its sha256 hash', async () => {
    const createdBy = await makeAdmin();

    const { id, plaintext } = await createAdminToken(db, { name: 'ci-bot', createdBy });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plaintext).toMatch(/^at_[A-Za-z0-9_-]+$/);

    const expectedHash = createHash('sha256').update(plaintext).digest('hex');
    const [row] = await db.select().from(schema.adminToken).where(eq(schema.adminToken.id, id));
    expect(row?.hash).toBe(expectedHash);
    expect(row?.hash).not.toContain(plaintext);
    expect(row?.name).toBe('ci-bot');
    expect(row?.createdBy).toBe(createdBy);
    expect(row?.status).toBe('active');
    expect(row?.expiresAt).toBeNull();
  });

  it('persists an optional expiresAt', async () => {
    const createdBy = await makeAdmin();
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');

    const { id } = await createAdminToken(db, { name: 'temp', createdBy, expiresAt });

    const [row] = await db.select().from(schema.adminToken).where(eq(schema.adminToken.id, id));
    expect(row?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it('generates distinct plaintext tokens on each call', async () => {
    const createdBy = await makeAdmin();
    const a = await createAdminToken(db, { name: 'a', createdBy });
    const b = await createAdminToken(db, { name: 'b', createdBy });
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe('findAdminTokenByHash', () => {
  it('round-trips by sha256 hash, carrying status + expiresAt + createdBy', async () => {
    const createdBy = await makeAdmin();
    const expiresAt = new Date('2030-06-01T00:00:00.000Z');
    const { id, plaintext } = await createAdminToken(db, { name: 'svc', createdBy, expiresAt });
    const hash = createHash('sha256').update(plaintext).digest('hex');

    const found = await findAdminTokenByHash(db, hash);

    expect(found?.id).toBe(id);
    expect(found?.createdBy).toBe(createdBy);
    expect(found?.status).toBe('active');
    expect(found?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it('returns undefined for an unknown hash', async () => {
    expect(await findAdminTokenByHash(db, 'deadbeef')).toBeUndefined();
  });

  it('returns undefined for a revoked (soft-deleted) token', async () => {
    const createdBy = await makeAdmin();
    const { id, plaintext } = await createAdminToken(db, { name: 'x', createdBy });
    const hash = createHash('sha256').update(plaintext).digest('hex');

    await softDeleteAdminToken(db, id);

    expect(await findAdminTokenByHash(db, hash)).toBeUndefined();
  });
});

describe('listAdminTokens', () => {
  it('lists live tokens newest-first without exposing the hash', async () => {
    const createdBy = await makeAdmin();
    await createAdminToken(db, { name: 'one', createdBy });
    await createAdminToken(db, { name: 'two', createdBy });

    const { rows, hasMore } = await listAdminTokens(db, { limit: 10 });

    expect(rows).toHaveLength(2);
    expect(hasMore).toBe(false);
    expect(rows[0]).not.toHaveProperty('hash');
    expect(rows.map((r) => r.name).sort()).toEqual(['one', 'two']);
  });

  it('excludes revoked tokens', async () => {
    const createdBy = await makeAdmin();
    const a = await createAdminToken(db, { name: 'a', createdBy });
    await createAdminToken(db, { name: 'b', createdBy });
    await softDeleteAdminToken(db, a.id);

    const { rows } = await listAdminTokens(db, { limit: 10 });

    expect(rows.map((r) => r.name)).toEqual(['b']);
  });
});

describe('softDeleteAdminToken', () => {
  it('soft-deletes a live token and is a safe no-op on the second call', async () => {
    const createdBy = await makeAdmin();
    const { id } = await createAdminToken(db, { name: 'gone', createdBy });

    expect(await softDeleteAdminToken(db, id)).toBe(id);
    expect(await softDeleteAdminToken(db, id)).toBeUndefined();
  });
});
