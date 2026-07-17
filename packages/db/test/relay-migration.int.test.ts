import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index.js';

// Resolve relative to this file so the migrator finds the journal regardless of
// the process cwd (vitest may run from the package root or the repo root).
const DRIZZLE_DIR = join(import.meta.dirname, '..', 'drizzle');

// The Track C relay tables. Asserted by name (not by migration number) so a
// future renumbering/squash of migrations can't silently drop the assertion.
// 批次6 D4: `model` / `model_grant` were dropped by mig 0072 (old-world
// deletion) — only the surviving relay tables are asserted here.
const RELAY_TABLES = ['usage_log', 'redemption_code'] as const;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client, { schema });
  // Apply the WHOLE migration chain forward via the drizzle migrator.
  await migrate(db, { migrationsFolder: DRIZZLE_DIR });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

describe('relay tables after full migration', () => {
  it('creates usage_log, redemption_code', async () => {
    for (const table of RELAY_TABLES) {
      const rows = await client`SELECT to_regclass(${`public.${table}`}) AS reg`;
      expect(rows[0]?.reg).toBe(table);
    }
  });
});
