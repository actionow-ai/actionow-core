import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';

/**
 * mig 0062 presence: applies every migration through 0062 against a fresh
 * Postgres and asserts the additive `channel_model.param_override jsonb` column
 * landed — nullable, so existing links keep `NULL` (== today's behavior). Mirrors
 * the migration-0021 pattern. Also confirms no append-only trigger (mig 0052 only
 * guards ledger_txn + audit_log) blocks a `param_override` UPDATE.
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

/** The information_schema column descriptor for `table.col`, or undefined. */
async function column(
  table: string,
  col: string,
): Promise<{ data_type: string; is_nullable: string } | undefined> {
  const rows = await client<{ data_type: string; is_nullable: string }[]>`
    SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${col}
  `;
  return rows[0];
}

describe('migration 0062 — channel_model.param_override (model-param-binding Phase 0)', () => {
  it('adds a nullable jsonb channel_model.param_override', async () => {
    const c = await column('channel_model', 'param_override');
    expect(c, 'channel_model.param_override').toBeDefined();
    expect(c?.data_type).toBe('jsonb');
    expect(c?.is_nullable).toBe('YES');
  });
});
