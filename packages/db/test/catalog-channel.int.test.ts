import { createResource, createUpstreamChannel, listChannels, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const { tenant } = schema;
let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE upstream_channel, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

describe('upstream_channel endpoint/model/proxy_ref/config columns', () => {
  it('persists and reads back endpoint, model, proxy_ref, and config (jsonb round-trip)', async () => {
    const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
    if (!t) throw new Error('no tenant');
    await createResource(db, {
      id: 'deepseek-chat',
      tenantId: t.id,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
      version: 1,
    });
    const config = {
      submitPath: '/api/v1/tasks',
      pollPath: '/api/v1/tasks/{id}',
      signatureHeader: 'X-Relay-Signature',
      timestampHeader: 'X-Relay-Timestamp',
    };
    await createUpstreamChannel(db, {
      resourceId: 'deepseek-chat',
      providerType: 'openai',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      proxyRef: 'upstream_proxy',
      config,
      weight: 1,
      status: 'active',
    });
    const [row] = await listChannels(db, 'deepseek-chat');
    expect(row?.endpoint).toBe('https://api.deepseek.com/v1');
    expect(row?.model).toBe('deepseek-chat');
    expect(row?.proxyRef).toBe('upstream_proxy');
    expect(row?.config).toEqual(config);
  });

  it('defaults the new columns to null when omitted', async () => {
    const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
    if (!t) throw new Error('no tenant');
    await createResource(db, {
      id: 'bare-model',
      tenantId: t.id,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
      version: 1,
    });
    await createUpstreamChannel(db, {
      resourceId: 'bare-model',
      providerType: 'openai',
    });
    const [row] = await listChannels(db, 'bare-model');
    expect(row?.endpoint).toBeNull();
    expect(row?.model).toBeNull();
    expect(row?.proxyRef).toBeNull();
    expect(row?.config).toBeNull();
  });
});
