import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
    await client`INSERT INTO "user" (email, role) VALUES ('u@x.com', 'user')`;
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
