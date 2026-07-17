import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';

/**
 * mig 0072 — 批次6 D4 (旧世界删除, DROP migration). Applies the WHOLE chain
 * (0000 → 0072) against a fresh throwaway Testcontainers Postgres — the old
 * world is built up by the historical migrations and torn down by 0072 — and
 * asserts:
 *
 * 1. the 12 old-world tables are GONE;
 * 2. the 3 kept-table FK constraints to the old world are GONE (dropped
 *    BEFORE the tables — hand-reordered in the migration);
 * 3. the kept assets survive: `ledger_txn.job_id` keeps its COLUMN (historic
 *    settle attribution) + the `ledger_settle_per_job` partial unique index;
 *    `channel_breaker` / `route_group_channel` keep their tables + plain-uuid
 *    `channel_id` columns; the secret vault / pricing / supply / task tables
 *    all still exist;
 * 4. behavior: the freed columns now accept uuids with NO backing row.
 */
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

/** The 12 old-world tables dropped by 0072. */
const DROPPED_TABLES = [
  'dify_binding',
  'resource',
  'resource_version',
  'upstream_channel',
  'job',
  'webhook_outbox',
  'channel_model',
  'model',
  'model_grant',
  'provider_plugin',
  'provider_plugin_version',
  'pricebook_entry',
] as const;

/** The 3 kept-table FK constraints to the old world dropped by 0072. */
const DROPPED_FKS = [
  'ledger_txn_job_id_job_id_fk',
  'channel_breaker_channel_id_upstream_channel_id_fk',
  'route_group_channel_channel_id_upstream_channel_id_fk',
] as const;

/** Kept assets that must SURVIVE the drop (spot-check, not exhaustive). */
const KEPT_TABLES = [
  'secret_ref',
  'secret_material',
  'modifier',
  'gift_code',
  'ledger_txn',
  'idempotency_key',
  'request_idempotency',
  'account',
  'audit_log',
  'route_group',
  'route_group_channel',
  'channel_breaker',
  'limit_plan',
  'official_model_price',
  'model_spec',
  'fault_policy',
  'platform_setting',
  'relay_trace',
  'usage_log',
  'supply_provider',
  'supply_channel',
  'supply_credential',
  'supply_model',
  'supply_model_grant',
  'supply_offering',
  'supply_price_card',
  'supply_offering_breaker',
  'task',
  'task_events',
  'webhook_deliveries',
] as const;

/** `to_regclass` for `public.<table>` — null iff the table does not exist. */
async function tableReg(table: string): Promise<string | null> {
  const rows = await client<{ reg: string | null }[]>`
    SELECT to_regclass(${`public.${table}`})::text AS reg
  `;
  return rows[0]?.reg ?? null;
}

/** True iff a FOREIGN KEY constraint named `name` exists anywhere. */
async function hasFk(name: string): Promise<boolean> {
  const rows = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ${name} AND contype = 'f'
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/** True iff column `col` exists on `table`. */
async function hasColumn(table: string, col: string): Promise<boolean> {
  const rows = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${col}
  `;
  return (rows[0]?.n ?? 0) > 0;
}

describe('migration 0072 — old-world DROP (批次6 D4)', () => {
  it('drops all 12 old-world tables', async () => {
    for (const t of DROPPED_TABLES) {
      expect(await tableReg(t), `${t} should be dropped`).toBeNull();
    }
  });

  it('drops the 3 kept-table FK constraints to the old world', async () => {
    for (const fk of DROPPED_FKS) {
      expect(await hasFk(fk), `${fk} should be dropped`).toBe(false);
    }
  });

  it('keeps every retained table (spot-check)', async () => {
    for (const t of KEPT_TABLES) {
      expect(await tableReg(t), `${t} should survive`).toBe(t);
    }
  });

  it('ledger_txn keeps its job_id COLUMN (historic attribution) + settle-once index', async () => {
    expect(await hasColumn('ledger_txn', 'job_id')).toBe(true);
    const idx = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE indexname IN ('ledger_settle_per_job', 'ledger_job_idx')
    `;
    expect(idx[0]?.n).toBe(2);
  });

  it('channel_breaker / route_group_channel keep channel_id with NO remaining FK on it', async () => {
    for (const t of ['channel_breaker', 'route_group_channel']) {
      expect(await hasColumn(t, 'channel_id'), `${t}.channel_id`).toBe(true);
      const fks = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_constraint
        WHERE contype = 'f' AND conrelid = ${t}::regclass
          AND EXISTS (
            SELECT 1 FROM unnest(conkey) AS k
            JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k
            WHERE a.attname = 'channel_id'
          )
      `;
      expect(fks[0]?.n, `${t}.channel_id FK count`).toBe(0);
    }
  });

  it('freed columns accept uuids with no backing row (behavioral)', async () => {
    // channel_breaker: a breaker row for a channel id that exists nowhere.
    const chBreaker = randomUUID();
    await db
      .insert(schema.channelBreaker)
      .values({ channelId: chBreaker, model: 'gpt-x', state: 'open' });

    // route_group_channel: a membership row for a channel id that exists nowhere.
    const [group] = await db.insert(schema.routeGroup).values({ name: 'g-0072' }).returning();
    if (!group) throw new Error('route_group insert returned no row');
    await db
      .insert(schema.routeGroupChannel)
      .values({ groupId: group.id, channelId: randomUUID() });

    // ledger_txn: a settle row attributed to a job id that no longer resolves.
    const [t] = await db.insert(schema.tenant).values({ name: 't-0072' }).returning();
    if (!t) throw new Error('tenant insert returned no row');
    const [acct] = await db.insert(schema.account).values({ tenantId: t.id }).returning();
    if (!acct) throw new Error('account insert returned no row');
    await db.insert(schema.ledgerTxn).values({
      tenantId: t.id,
      accountId: acct.id,
      type: 'settle',
      creditsDelta: -1n,
      balanceAfter: 0n,
      jobId: randomUUID(),
    });

    const n = await client<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger_txn`;
    expect(n[0]?.n).toBe(1);
  });

  it('records the full 73-migration chain in drizzle bookkeeping', async () => {
    const rows = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
    `;
    expect(rows[0]?.n).toBe(73);
  });
});
