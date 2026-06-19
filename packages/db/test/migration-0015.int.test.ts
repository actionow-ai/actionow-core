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

describe('migration 0015 — schema hardening (Track A)', () => {
  it('adds created_at where it was missing', async () => {
    for (const t of ['oauth_session', 'gift_code', 'dify_binding', 'channel_health']) {
      expect(await hasColumn(t, 'created_at'), `${t}.created_at`).toBe(true);
    }
  });

  it('adds updated_at to the mutable tables that lacked it', async () => {
    for (const t of [
      'tenant',
      'api_key',
      'user',
      'resource',
      'upstream_channel',
      'pricebook_entry',
      'modifier',
      'secret_ref',
      'file_object',
    ]) {
      expect(await hasColumn(t, 'updated_at'), `${t}.updated_at`).toBe(true);
    }
  });

  it('adds deleted_at to every soft-delete table', async () => {
    for (const t of [
      'tenant',
      'account',
      'api_key',
      'resource',
      'model',
      'upstream_channel',
      'secret_ref',
      'oauth_session',
      'pricebook_entry',
      'modifier',
      'dify_binding',
      'redemption_code',
    ]) {
      expect(await hasColumn(t, 'deleted_at'), `${t}.deleted_at`).toBe(true);
    }
  });

  it('does NOT add deleted_at to ephemeral/audit tables', async () => {
    for (const t of ['job', 'ledger_txn', 'usage_log', 'relay_trace', 'webhook_outbox']) {
      expect(await hasColumn(t, 'deleted_at'), `${t}.deleted_at should be absent`).toBe(false);
    }
  });

  it('creates the FK indexes', async () => {
    for (const name of [
      'dify_binding_resource_idx',
      'resource_tenant_idx',
      'resource_version_resource_idx',
      'ledger_txn_tenant_idx',
      'ledger_txn_account_idx',
      'webhook_outbox_job_idx',
      'user_tenant_idx',
      'redemption_code_redeemed_by_tenant_idx',
    ]) {
      expect(await hasIndex(name), name).toBe(true);
    }
  });

  it('creates the status CHECK constraints', async () => {
    for (const name of [
      'job_status_allowed',
      'oauth_session_status_allowed',
      'payment_intent_status_allowed',
      'redemption_code_status_allowed',
      'gift_code_status_allowed',
      'resource_status_allowed',
      'upstream_channel_status_allowed',
      'model_status_allowed',
      'file_object_status_allowed',
      'usage_log_status_allowed',
      'webhook_outbox_status_allowed',
      'api_key_status_allowed',
    ]) {
      expect(await hasCheck(name), name).toBe(true);
    }
  });

  it('the job status CHECK rejects an out-of-set value and accepts a valid one', async () => {
    const [t] = await client`INSERT INTO tenant (name) VALUES ('chk') RETURNING id`;
    if (!t) throw new Error('tenant insert returned no row');
    const [r] = await client`
      INSERT INTO resource (id, tenant_id, kind, modality, provider_type, exec_modes, current_version)
      VALUES ('chk-res', ${t.id}, 'model', 'text', 'openai', '["blocking"]'::jsonb, 1) RETURNING id`;
    if (!r) throw new Error('resource insert returned no row');

    await expect(
      client`INSERT INTO job (tenant_id, resource_id, resource_version, status, exec_mode, inputs)
             VALUES (${t.id}, ${r.id}, 1, 'bogus', 'blocking', '{}'::jsonb)`,
    ).rejects.toThrow();

    await client`INSERT INTO job (tenant_id, resource_id, resource_version, status, exec_mode, inputs)
                 VALUES (${t.id}, ${r.id}, 1, 'queued', 'blocking', '{}'::jsonb)`;
    const rows = await client<{ n: number }[]>`SELECT count(*)::int AS n FROM job`;
    expect(rows[0]?.n).toBe(1);

    await client`TRUNCATE TABLE job, resource, tenant RESTART IDENTITY CASCADE`;
  });
});
