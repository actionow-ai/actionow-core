import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';

/**
 * Track A migration-presence: applies every migration through 0015 against a
 * fresh Postgres and asserts the hardening DDL landed — the new timestamp /
 * soft-delete columns, the FK indexes, and the status CHECK constraints. Mirrors
 * the existing migration-presence pattern (e.g. relay-trace.int.test.ts).
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

/** True iff column `col` exists on `table` (information_schema). */
async function hasColumn(table: string, col: string): Promise<boolean> {
  const rows = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${col}
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/** True iff an index named `name` exists. */
async function hasIndex(name: string): Promise<boolean> {
  const rows = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = ${name}
  `;
  return (rows[0]?.n ?? 0) > 0;
}

/** True iff a CHECK constraint named `name` exists. */
async function hasCheck(name: string): Promise<boolean> {
  const rows = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE conname = ${name} AND contype = 'c'
  `;
  return (rows[0]?.n ?? 0) > 0;
}

// 批次6 D4: this suite asserts the FINAL schema after the whole chain, and
// mig 0072 drops the old-world tables (resource / upstream_channel / model /
// pricebook_entry / dify_binding / job / webhook_outbox / …) — their 0015
// hardening assertions (and the job-status CHECK behavior test) are retired;
// migration-0072.int.test.ts asserts the drops.
describe('migration 0015 — schema hardening (Track A)', () => {
  it('adds created_at where it was missing', async () => {
    // `channel_health` (also hardened by 0015) is dropped in 0048 (resilience-v2),
    // so it is no longer part of the final schema asserted here.
    for (const t of ['oauth_session', 'gift_code']) {
      expect(await hasColumn(t, 'created_at'), `${t}.created_at`).toBe(true);
    }
  });

  it('adds updated_at to the mutable tables that lacked it', async () => {
    for (const t of ['tenant', 'api_key', 'user', 'modifier', 'secret_ref', 'file_object']) {
      expect(await hasColumn(t, 'updated_at'), `${t}.updated_at`).toBe(true);
    }
  });

  it('adds deleted_at to every soft-delete table', async () => {
    for (const t of [
      'tenant',
      'account',
      'api_key',
      'secret_ref',
      'oauth_session',
      'modifier',
      'redemption_code',
    ]) {
      expect(await hasColumn(t, 'deleted_at'), `${t}.deleted_at`).toBe(true);
    }
  });

  it('does NOT add deleted_at to ephemeral/audit tables', async () => {
    for (const t of ['ledger_txn', 'usage_log', 'relay_trace']) {
      expect(await hasColumn(t, 'deleted_at'), `${t}.deleted_at should be absent`).toBe(false);
    }
  });

  it('creates the FK indexes', async () => {
    for (const name of [
      'ledger_txn_tenant_idx',
      'ledger_txn_account_idx',
      'user_tenant_idx',
      'redemption_code_redeemed_by_tenant_idx',
    ]) {
      expect(await hasIndex(name), name).toBe(true);
    }
  });

  it('creates the status CHECK constraints', async () => {
    for (const name of [
      'oauth_session_status_allowed',
      'payment_intent_status_allowed',
      'redemption_code_status_allowed',
      'gift_code_status_allowed',
      'file_object_status_allowed',
      'usage_log_status_allowed',
      'api_key_status_allowed',
    ]) {
      expect(await hasCheck(name), name).toBe(true);
    }
  });
});
