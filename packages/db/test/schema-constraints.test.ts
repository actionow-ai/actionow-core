import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { schema } from '../src/index.js';

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
  await client`TRUNCATE TABLE account, "user", tenant RESTART IDENTITY CASCADE`;
});

describe('schema constraints (Track B Task 1)', () => {
  it('rejects a user.role outside (user|admin)', async () => {
    await expect(
      client`INSERT INTO "user" (email, role) VALUES ('bad@x.com', 'superuser')`,
    ).rejects.toThrow();
  });

  it('accepts role=user and role=admin', async () => {
    // role=user now requires a tenant_role (rbac CHECK); role=admin keeps it NULL.
    await client`INSERT INTO "user" (email, role, tenant_role) VALUES ('u@x.com', 'user', 'admin')`;
    await client`INSERT INTO "user" (email, role) VALUES ('a@x.com', 'admin')`;
    const rows = await client<{ role: string }[]>`SELECT role FROM "user" ORDER BY email`;
    expect(rows.map((r) => r.role)).toEqual(['admin', 'user']);
  });

  it('forbids a second account for the same tenant (unique tenant_id)', async () => {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('t') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    await client`INSERT INTO account (tenant_id) VALUES (${t.id})`;
    await expect(client`INSERT INTO account (tenant_id) VALUES (${t.id})`).rejects.toThrow();
  });

  // 批次6 D3 (旧世界删除): the `job.account_id` FK test died with the old `job` world.
});

describe('user.tenant_role constraint (rbac Task 1)', () => {
  it('rejects role=user with a NULL tenant_role', async () => {
    await expect(
      client`INSERT INTO "user" (email, role) VALUES ('bad@x.com', 'user')`,
    ).rejects.toThrow();
  });

  it('rejects role=admin with a non-NULL tenant_role', async () => {
    await expect(
      client`INSERT INTO "user" (email, role, tenant_role) VALUES ('bad2@x.com', 'admin', 'admin')`,
    ).rejects.toThrow();
  });

  it('rejects a tenant_role outside (admin|member)', async () => {
    await expect(
      client`INSERT INTO "user" (email, role, tenant_role) VALUES ('bad3@x.com', 'user', 'owner')`,
    ).rejects.toThrow();
  });

  it('accepts role=user with tenant_role admin or member, and role=admin with NULL', async () => {
    await client`INSERT INTO "user" (email, role, tenant_role) VALUES ('ta@x.com', 'user', 'admin')`;
    await client`INSERT INTO "user" (email, role, tenant_role) VALUES ('tm@x.com', 'user', 'member')`;
    await client`INSERT INTO "user" (email, role) VALUES ('sys@x.com', 'admin')`;
    const rows = await client<
      { email: string; tenant_role: string | null }[]
    >`SELECT email, tenant_role FROM "user" ORDER BY email`;
    expect(rows).toEqual([
      { email: 'sys@x.com', tenant_role: null },
      { email: 'ta@x.com', tenant_role: 'admin' },
      { email: 'tm@x.com', tenant_role: 'member' },
    ]);
  });
});

describe('channel_breaker (弹性2.0)', () => {
  /**
   * 批次6 D4: `channel_breaker.channel_id` is a plain uuid — mig 0072 dropped
   * the old `resource`/`upstream_channel` tables and the FK — so a fresh
   * random uuid stands in for a channel id with no backing row.
   */
  function makeChannel(): string {
    return randomUUID();
  }

  it('rejects an invalid breaker state', async () => {
    const ch = makeChannel();
    await expect(
      db.insert(schema.channelBreaker).values({ channelId: ch, model: 'gpt-x', state: 'bogus' }),
    ).rejects.toThrow();
  });

  it('accepts the three valid states + composite PK', async () => {
    const ch = makeChannel();
    for (const state of ['closed', 'open', 'half_open']) {
      await db.insert(schema.channelBreaker).values({ channelId: ch, model: `m-${state}`, state });
    }
    const rows = await db
      .select()
      .from(schema.channelBreaker)
      .where(eq(schema.channelBreaker.channelId, ch));
    expect(rows).toHaveLength(3);
  });

  it('enforces the composite PK (channel_id, model)', async () => {
    const ch = makeChannel();
    await db.insert(schema.channelBreaker).values({ channelId: ch, model: 'dup', state: 'closed' });
    await expect(
      db.insert(schema.channelBreaker).values({ channelId: ch, model: 'dup', state: 'open' }),
    ).rejects.toThrow();
  });
});

// 批次6 D3 (旧世界删除): the `channel.tags (route tagging)` describe over the
// deleted `upstream_channel` schema definition is gone with its table.

describe('session (migration 0056 — refresh-token rotation)', () => {
  /** Insert a user; return its id (for `principal_kind='user'` linkage). */
  async function makeUserRow(email: string): Promise<string> {
    const [u] =
      await client`INSERT INTO "user" (email, role, tenant_role) VALUES (${email}, 'user', 'admin') RETURNING id`;
    if (!u) throw new Error('user insert returned no row');
    return u.id as string;
  }

  it('rejects a principal_kind outside (user|subject|admin)', async () => {
    await expect(
      client`INSERT INTO session (principal_kind, refresh_hash, family_id, expires_at) VALUES ('bogus', 'h1', gen_random_uuid(), now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('rejects a user session with NULL user_id (linkage CHECK)', async () => {
    await expect(
      client`INSERT INTO session (principal_kind, refresh_hash, family_id, expires_at) VALUES ('user', 'h2', gen_random_uuid(), now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('rejects a user session that ALSO sets subject_id (linkage CHECK)', async () => {
    const uid = await makeUserRow('linkage-user@x.com');
    const [t] = await client`INSERT INTO tenant (name) VALUES ('lk') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    const [s] =
      await client`INSERT INTO subject (tenant_id, external_id) VALUES (${t.id}, 'lk-ext') RETURNING id`;
    if (!s) throw new Error('subject insert returned no row');
    await expect(
      client`INSERT INTO session (principal_kind, user_id, subject_id, refresh_hash, family_id, expires_at) VALUES ('user', ${uid}, ${s.id}, 'h3', gen_random_uuid(), now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('rejects a subject session with NULL subject_id (linkage CHECK)', async () => {
    await expect(
      client`INSERT INTO session (principal_kind, refresh_hash, family_id, expires_at) VALUES ('subject', 'h4', gen_random_uuid(), now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('accepts a valid user session, a subject session, and an admin session', async () => {
    const uid = await makeUserRow('ok-user@x.com');
    const [t] = await client`INSERT INTO tenant (name) VALUES ('ok') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    const [s] =
      await client`INSERT INTO subject (tenant_id, external_id) VALUES (${t.id}, 'ok-ext') RETURNING id`;
    if (!s) throw new Error('subject insert returned no row');

    await client`INSERT INTO session (principal_kind, user_id, refresh_hash, family_id, expires_at) VALUES ('user', ${uid}, 'ok-h-user', gen_random_uuid(), now() + interval '1 day')`;
    await client`INSERT INTO session (principal_kind, subject_id, tenant_id, refresh_hash, family_id, expires_at) VALUES ('subject', ${s.id}, ${t.id}, 'ok-h-subject', gen_random_uuid(), now() + interval '1 day')`;
    // admin carries neither FK (the user id may be stored in user_id; both pass).
    await client`INSERT INTO session (principal_kind, refresh_hash, family_id, expires_at) VALUES ('admin', 'ok-h-admin', gen_random_uuid(), now() + interval '1 day')`;

    const rows = await client<
      { principal_kind: string }[]
    >`SELECT principal_kind FROM session ORDER BY principal_kind`;
    expect(rows.map((r) => r.principal_kind)).toEqual(['admin', 'subject', 'user']);
  });

  it('enforces UNIQUE on refresh_hash', async () => {
    const uid = await makeUserRow('uq-user@x.com');
    await client`INSERT INTO session (principal_kind, user_id, refresh_hash, family_id, expires_at) VALUES ('user', ${uid}, 'dup-hash', gen_random_uuid(), now() + interval '1 day')`;
    await expect(
      client`INSERT INTO session (principal_kind, user_id, refresh_hash, family_id, expires_at) VALUES ('user', ${uid}, 'dup-hash', gen_random_uuid(), now() + interval '1 day')`,
    ).rejects.toThrow();
  });
});

describe('schema hardening (migration 0052)', () => {
  /** Insert a tenant + its account; return both ids. */
  async function makeAccount(name: string): Promise<{ tenantId: string; accountId: string }> {
    const [t] = await client`INSERT INTO tenant (name) VALUES (${name}) RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    const [a] = await client`INSERT INTO account (tenant_id) VALUES (${t.id}) RETURNING id`;
    if (!a) throw new Error('account insert returned no row');
    return { tenantId: t.id as string, accountId: a.id as string };
  }

  it('rejects a ledger_txn.type outside the allowed set', async () => {
    const { tenantId, accountId } = await makeAccount('lt');
    await expect(
      client`INSERT INTO ledger_txn (tenant_id, account_id, type, credits_delta, balance_after) VALUES (${tenantId}, ${accountId}, 'bogus', 0, 0)`,
    ).rejects.toThrow();
    // a real type still inserts
    await client`INSERT INTO ledger_txn (tenant_id, account_id, type, credits_delta, balance_after) VALUES (${tenantId}, ${accountId}, 'transfer_in', 0, 0)`;
  });

  it('enforces append-only on ledger_txn (UPDATE/DELETE blocked, INSERT allowed)', async () => {
    const { tenantId, accountId } = await makeAccount('ao');
    await client`INSERT INTO ledger_txn (tenant_id, account_id, type, credits_delta, balance_after) VALUES (${tenantId}, ${accountId}, 'topup', 100, 100)`;
    await expect(
      client`UPDATE ledger_txn SET balance_after = 1 WHERE tenant_id = ${tenantId}`,
    ).rejects.toThrow();
    await expect(client`DELETE FROM ledger_txn WHERE tenant_id = ${tenantId}`).rejects.toThrow();
  });

  it('rejects a negative account balance', async () => {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('neg') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    await expect(
      client`INSERT INTO account (tenant_id, credit_balance) VALUES (${t.id}, -5)`,
    ).rejects.toThrow();
  });

  it('rejects a subject with neither email nor external_id (addressable)', async () => {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('subj') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    await expect(
      client`INSERT INTO subject (tenant_id, status) VALUES (${t.id}, 'active')`,
    ).rejects.toThrow();
    // either identity makes it addressable
    await client`INSERT INTO subject (tenant_id, external_id) VALUES (${t.id}, 'ext-1')`;
  });

  // 批次6 D4: the `provider_plugin.slug` partial-unique test died with its
  // table (mig 0072 dropped `provider_plugin`).
});
