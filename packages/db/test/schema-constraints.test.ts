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
