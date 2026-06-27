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
  await client`TRUNCATE TABLE job, account, "user", tenant RESTART IDENTITY CASCADE`;
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

  it('job carries a nullable account_id FK to account', async () => {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('t2') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    const [a] = await client`INSERT INTO account (tenant_id) VALUES (${t.id}) RETURNING id`;
    if (!a) throw new Error('account insert returned no row');
    const [r] =
      await client`INSERT INTO resource (id, tenant_id, kind, modality, provider_type, exec_modes, current_version) VALUES ('res1', ${t.id}, 'model', 'text', 'openai', '["blocking"]'::jsonb, 1) RETURNING id`;
    if (!r) throw new Error('resource insert returned no row');
    await client`INSERT INTO job (tenant_id, resource_id, resource_version, status, exec_mode, inputs, account_id) VALUES (${t.id}, ${r.id}, 1, 'queued', 'blocking', '{}'::jsonb, ${a.id})`;
    const rows = await client`SELECT account_id FROM job`;
    expect(rows[0]?.account_id).toBe(a.id);
  });
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
  /** Insert a minimal tenant → resource → upstream_channel chain; return the channel id. */
  async function makeChannel(): Promise<string> {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('brk') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    await client`
      INSERT INTO resource (id, tenant_id, kind, modality, provider_type, exec_modes, current_version)
      VALUES ('brk-res', ${t.id}, 'model', 'text', 'mock-chat', '["blocking"]'::jsonb, 1)
    `;
    const [ch] = await client`
      INSERT INTO upstream_channel (resource_id, provider_type) VALUES ('brk-res', 'mock-chat') RETURNING id
    `;
    if (!ch) throw new Error('upstream_channel insert returned no row');
    return ch.id as string;
  }

  it('rejects an invalid breaker state', async () => {
    const ch = await makeChannel();
    await expect(
      db.insert(schema.channelBreaker).values({ channelId: ch, model: 'gpt-x', state: 'bogus' }),
    ).rejects.toThrow();
  });

  it('accepts the three valid states + composite PK', async () => {
    const ch = await makeChannel();
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
    const ch = await makeChannel();
    await db.insert(schema.channelBreaker).values({ channelId: ch, model: 'dup', state: 'closed' });
    await expect(
      db.insert(schema.channelBreaker).values({ channelId: ch, model: 'dup', state: 'open' }),
    ).rejects.toThrow();
  });
});

describe('channel.tags (route tagging)', () => {
  /** Insert a minimal tenant → resource chain; return the resource id. */
  async function makeResource(): Promise<string> {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('tag') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    await client`
      INSERT INTO resource (id, tenant_id, kind, modality, provider_type, exec_modes, current_version)
      VALUES ('tag-res', ${t.id}, 'model', 'text', 'openai', '["blocking"]'::jsonb, 1)
    `;
    return 'tag-res';
  }

  it('channel.tags defaults to empty array and round-trips values', async () => {
    const res = await makeResource();
    const [a] = await db
      .insert(schema.upstreamChannel)
      .values({ resourceId: res, providerType: 'openai' })
      .returning();
    expect(a?.tags).toEqual([]);
    const [b] = await db
      .insert(schema.upstreamChannel)
      .values({ resourceId: res, providerType: 'openai', tags: ['canary', 'beta'] })
      .returning();
    expect(b?.tags).toEqual(['canary', 'beta']);
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

  it('provider_plugin.slug is unique among LIVE rows but freed by soft-delete', async () => {
    const ins = (slug: string) =>
      client`INSERT INTO provider_plugin (slug, label, protocol, auth_strategy, manifest, handler) VALUES (${slug}, 'L', 'sync', 'bearer', '{}'::jsonb, 'h')`;
    await ins('p-uq-soft');
    await expect(ins('p-uq-soft')).rejects.toThrow(); // duplicate live slug
    await client`UPDATE provider_plugin SET deleted_at = now() WHERE slug = 'p-uq-soft' AND deleted_at IS NULL`;
    await ins('p-uq-soft'); // freed after soft-delete
  });
});
