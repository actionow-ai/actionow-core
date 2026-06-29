import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  getTenantFileTtlDays,
  listLiveFilesOlderThanForTenant,
  listTenantsWithFileTtl,
  markFileObjectsDeleted,
  setFileTtlDays,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, fileObject, tenant } = schema;

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
  await client`TRUNCATE TABLE file_object, account, tenant RESTART IDENTITY CASCADE`;
});

/** Create a tenant + its account (optional `file_ttl_days` config). Returns the ids. */
async function seedTenant(fileTtlDays?: number): Promise<{ tenantId: string; accountId: string }> {
  const [t] = await db.insert(tenant).values({ name: 'tenant' }).returning({ id: tenant.id });
  if (t === undefined) throw new Error('seedTenant: no tenant');
  const config = fileTtlDays === undefined ? {} : { file_ttl_days: fileTtlDays };
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, config })
    .returning({ id: account.id });
  if (a === undefined) throw new Error('seedTenant: no account');
  return { tenantId: t.id, accountId: a.id };
}

/** Insert one file_object row for a tenant, stamped at `createdAt`. Returns its id. */
async function seedFile(tenantId: string, createdAt: Date, key: string): Promise<string> {
  const [row] = await db
    .insert(fileObject)
    .values({ tenantId, provider: 'r2', bucket: 'b', key, createdAt })
    .returning({ id: fileObject.id });
  if (row === undefined) throw new Error('seedFile: no row');
  return row.id;
}

describe('listTenantsWithFileTtl', () => {
  it('returns only tenants with a strictly-positive effective TTL (+ platform-default fallback)', async () => {
    const withTtl = await seedTenant(7);
    const noTtl = await seedTenant(); // no config.file_ttl_days
    const zeroTtl = await seedTenant(0); // 0 must NOT be eligible

    // No platform default: only the explicit positive-TTL tenant.
    const none = await listTenantsWithFileTtl(db);
    expect(none).toHaveLength(1);
    expect(none[0]).toEqual({ tenantId: withTtl.tenantId, ttlDays: 7 });

    // With a platform default: the no-TTL tenant inherits it; the 0-TTL tenant
    // also inherits (its own 0 is invalid → falls back to the positive default).
    const withDefault = await listTenantsWithFileTtl(db, 30);
    const byTenant = new Map(withDefault.map((r) => [r.tenantId, r.ttlDays]));
    expect(byTenant.get(withTtl.tenantId)).toBe(7); // own override wins
    expect(byTenant.get(noTtl.tenantId)).toBe(30); // platform default
    expect(byTenant.get(zeroTtl.tenantId)).toBe(30); // invalid 0 → default
    expect(withDefault).toHaveLength(3);
  });

  it('omits a soft-deleted account even with a positive TTL', async () => {
    const t = await seedTenant(5);
    await db.update(account).set({ deletedAt: new Date() }).where(eq(account.id, t.accountId));
    expect(await listTenantsWithFileTtl(db, 30)).toHaveLength(0);
  });

  it('a 0 platform default with no overrides yields NO eligible tenants (data-loss guard)', async () => {
    await seedTenant(); // no override
    expect(await listTenantsWithFileTtl(db, 0)).toHaveLength(0);
  });
});

describe('listLiveFilesOlderThanForTenant', () => {
  it('respects the cutoff, deleted_at, tenant scope, and limit', async () => {
    const a = await seedTenant(7);
    const b = await seedTenant(7);

    const old1 = await seedFile(a.tenantId, new Date('2026-01-01Z'), 'a/old1');
    const old2 = await seedFile(a.tenantId, new Date('2026-01-02Z'), 'a/old2');
    await seedFile(a.tenantId, new Date('2026-06-01Z'), 'a/new'); // newer than cutoff
    const tombstoned = await seedFile(a.tenantId, new Date('2026-01-03Z'), 'a/dead');
    await db.update(fileObject).set({ deletedAt: new Date() }).where(eq(fileObject.id, tombstoned));
    await seedFile(b.tenantId, new Date('2026-01-01Z'), 'b/old'); // other tenant

    const cutoff = new Date('2026-03-01Z');
    const rows = await listLiveFilesOlderThanForTenant(db, a.tenantId, cutoff, 100);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([old1, old2].sort());

    // limit caps the batch size.
    const limited = await listLiveFilesOlderThanForTenant(db, a.tenantId, cutoff, 1);
    expect(limited).toHaveLength(1);
  });
});

describe('markFileObjectsDeleted', () => {
  it('soft-deletes the given live ids and is idempotent (re-mark = 0)', async () => {
    const a = await seedTenant(7);
    const f1 = await seedFile(a.tenantId, new Date('2026-01-01Z'), 'k1');
    const f2 = await seedFile(a.tenantId, new Date('2026-01-01Z'), 'k2');

    const first = await markFileObjectsDeleted(db, [f1, f2]);
    expect(first).toBe(2);

    // Both now carry a deleted_at tombstone.
    const live = await listLiveFilesOlderThanForTenant(
      db,
      a.tenantId,
      new Date('2026-06-01Z'),
      100,
    );
    expect(live).toHaveLength(0);

    // Re-marking the same ids is a no-op (already tombstoned).
    expect(await markFileObjectsDeleted(db, [f1, f2])).toBe(0);
    // Empty input is a 0-row no-op.
    expect(await markFileObjectsDeleted(db, [])).toBe(0);
  });
});

describe('setFileTtlDays / getTenantFileTtlDays', () => {
  it('sets a positive TTL, reads it back, then clears it', async () => {
    const t = await seedTenant(); // no config.file_ttl_days

    expect(await getTenantFileTtlDays(db, t.tenantId)).toBeNull();

    const set = await setFileTtlDays(db, t.accountId, 14);
    expect(set?.id).toBe(t.accountId);
    expect(await getTenantFileTtlDays(db, t.tenantId)).toBe(14);

    // Clearing removes the key (back to retain-forever default).
    const cleared = await setFileTtlDays(db, t.accountId, null);
    expect(cleared?.id).toBe(t.accountId);
    expect(await getTenantFileTtlDays(db, t.tenantId)).toBeNull();
  });

  it('preserves other config keys when merging the TTL', async () => {
    const [tt] = await db.insert(tenant).values({ name: 'tenant' }).returning({ id: tenant.id });
    if (tt === undefined) throw new Error('no tenant');
    const [a] = await db
      .insert(account)
      .values({ tenantId: tt.id, config: { storage_quota_bytes: 999 } })
      .returning({ id: account.id });
    if (a === undefined) throw new Error('no account');

    await setFileTtlDays(db, a.id, 9);
    const [row] = await db
      .select({ config: account.config })
      .from(account)
      .where(eq(account.id, a.id));
    expect(row?.config.storage_quota_bytes).toBe(999);
    expect(row?.config.file_ttl_days).toBe(9);
  });

  it('returns undefined for an unknown account id', async () => {
    expect(await setFileTtlDays(db, '00000000-0000-0000-0000-000000000000', 5)).toBeUndefined();
  });
});
