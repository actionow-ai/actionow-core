import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';

/**
 * Track 5 migration-presence: applies every migration through 0021 against a
 * fresh Postgres and asserts the additive billing/margin columns landed — the
 * channel `*_cost_per_1m` cost basis columns + `usage_log.provider_cost`. All
 * three are NULLABLE bigint (additive). Mirrors the migration-0015 pattern.
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

describe('migration 0021 — channel cost + usage_log.provider_cost (Track 5)', () => {
  it('adds nullable bigint upstream_channel.input_cost_per_1m / output_cost_per_1m', async () => {
    for (const col of ['input_cost_per_1m', 'output_cost_per_1m']) {
      const c = await column('upstream_channel', col);
      expect(c, `upstream_channel.${col}`).toBeDefined();
      expect(c?.data_type).toBe('bigint');
      expect(c?.is_nullable).toBe('YES');
    }
  });

  it('adds a nullable bigint usage_log.provider_cost', async () => {
    const c = await column('usage_log', 'provider_cost');
    expect(c).toBeDefined();
    expect(c?.data_type).toBe('bigint');
    expect(c?.is_nullable).toBe('YES');
  });
});
