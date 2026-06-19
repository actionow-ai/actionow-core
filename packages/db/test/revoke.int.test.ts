import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createApiKey,
  createEncryptedSecret,
  createOAuthSession,
  createTenant,
  findApiKeyByHash,
  getOAuthSession,
  getSecretRef,
  getSecretRefById,
  hashApiKey,
  listSecretRefs,
  resolveSecretRef,
  softDeleteApiKey,
  softDeleteOAuthSession,
  softDeleteSecretRef,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { apiKey, secretRef } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

// A valid base64 32-byte AES-256 key for the enc/oauth encryption paths.
const KEY_B64 = Buffer.alloc(32, 9).toString('base64');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE oauth_session, secret_material, secret_ref, api_key, tenant RESTART IDENTITY CASCADE`;
  process.env.SECRET_ENCRYPTION_KEY = KEY_B64;
});

describe('softDeleteApiKey: revoke denies resolution, double-delete is a no-op', () => {
  it('soft-deletes a tenant key so findApiKeyByHash returns undefined', async () => {
    const t = await createTenant(db, { name: 'rk-tenant' });
    const created = await createApiKey(db, { tenantId: t.id });
    const hash = hashApiKey(created.plaintext);
    expect(await findApiKeyByHash(db, hash)).toBeDefined();

    const id = await softDeleteApiKey(db, created.id, t.id);
    expect(id).toBe(created.id);
    expect(await findApiKeyByHash(db, hash)).toBeUndefined();

    // the row is stamped, not removed.
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('returns undefined on a second delete (no throw, idempotent revoke)', async () => {
    const t = await createTenant(db, { name: 'rk-tenant-2' });
    const created = await createApiKey(db, { tenantId: t.id });
    expect(await softDeleteApiKey(db, created.id, t.id)).toBe(created.id);
    expect(await softDeleteApiKey(db, created.id, t.id)).toBeUndefined();
  });

  it('returns undefined for a cross-tenant id (tenant predicate in SQL)', async () => {
    const a = await createTenant(db, { name: 'rk-a' });
    const b = await createTenant(db, { name: 'rk-b' });
    const created = await createApiKey(db, { tenantId: a.id });
    expect(await softDeleteApiKey(db, created.id, b.id)).toBeUndefined();
    // untouched: a's key still resolves.
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id));
    expect(row?.deletedAt).toBeNull();
  });
});

describe('softDeleteOAuthSession: revoke denies resolution', () => {
  it('soft-deletes the session so resolveSecretRef returns undefined', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'rev-access',
      refreshToken: 'rev-refresh',
      keyB64: KEY_B64,
    });
    await expect(resolveSecretRef(db, ref.id)).resolves.toBe('rev-access');

    const id = await softDeleteOAuthSession(db, ref.id);
    expect(id).toBe(ref.id);

    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
    expect(await getOAuthSession(db, ref.id)).toBeUndefined();
    // its owning secret_ref is also stamped so it disappears from secret listings.
    expect(await getSecretRef(db, ref.id)).toBeUndefined();
  });

  it('returns undefined on a second delete (no throw)', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'rev-access-2',
      refreshToken: 'rev-refresh-2',
      keyB64: KEY_B64,
    });
    expect(await softDeleteOAuthSession(db, ref.id)).toBe(ref.id);
    expect(await softDeleteOAuthSession(db, ref.id)).toBeUndefined();
  });
});

describe('softDeleteSecretRef: revoke denies resolution', () => {
  it('soft-deletes an enc secret so resolveSecretRef returns undefined', async () => {
    const ref = await createEncryptedSecret(db, {
      value: 'sk-revoke-me',
      label: 'openai',
      keyB64: KEY_B64,
    });
    await expect(resolveSecretRef(db, ref.id)).resolves.toBe('sk-revoke-me');

    const id = await softDeleteSecretRef(db, ref.id);
    expect(id).toBe(ref.id);

    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
    expect(await getSecretRef(db, ref.id)).toBeUndefined();
    // the material row is intentionally left behind; the deleted_at filter on
    // getSecretRef is what makes resolution fail.
    const [mat] = await db
      .select()
      .from(schema.secretMaterial)
      .where(eq(schema.secretMaterial.secretRefId, ref.id));
    expect(mat).toBeDefined();
  });

  it('returns undefined on a second delete (no throw)', async () => {
    const [ref] = await db
      .insert(secretRef)
      .values({ provider: 'env', locator: 'rev-env' })
      .returning();
    if (!ref) throw new Error('secret_ref insert returned no row');
    expect(await softDeleteSecretRef(db, ref.id)).toBe(ref.id);
    expect(await softDeleteSecretRef(db, ref.id)).toBeUndefined();
  });
});

describe('listSecretRefs / getSecretRefById: metadata only, deleted excluded', () => {
  it('lists live secrets newest-first with only metadata, never the material', async () => {
    const a = await createEncryptedSecret(db, { value: 'sk-a', label: 'a', keyB64: KEY_B64 });
    const b = await createEncryptedSecret(db, { value: 'sk-b', label: 'b', keyB64: KEY_B64 });

    const { rows, hasMore } = await listSecretRefs(db, { limit: 200 });
    expect(hasMore).toBe(false);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // metadata-only shape (id/provider/locator/timestamps) — and NO material leaks.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('sk-a');
    expect(serialized).not.toContain('sk-b');
    for (const r of rows) {
      expect(r.provider).toBe('enc');
      expect(r).toHaveProperty('locator');
      expect(r.createdAt).toBeInstanceOf(Date);
    }

    // soft-delete one → it drops out of the listing AND getSecretRefById.
    await softDeleteSecretRef(db, a.id);
    const after = await listSecretRefs(db, { limit: 200 });
    expect(after.rows.map((r) => r.id)).not.toContain(a.id);
    expect(await getSecretRefById(db, a.id)).toBeUndefined();
    expect((await getSecretRefById(db, b.id))?.id).toBe(b.id);
  });

  it('paginates with limit + cursor (has_more flips)', async () => {
    await createEncryptedSecret(db, { value: 'sk-1', keyB64: KEY_B64 });
    await createEncryptedSecret(db, { value: 'sk-2', keyB64: KEY_B64 });

    const first = await listSecretRefs(db, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const last = first.rows[0];
    if (last === undefined) throw new Error('no first row');
    const second = await listSecretRefs(db, {
      limit: 1,
      cursor: { createdAt: last.createdAt, id: last.id },
    });
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.rows[0]?.id).not.toBe(last.id);
  });
});
