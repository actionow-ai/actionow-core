import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createResource } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { model, modelGrant, tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE model_grant, model, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

async function makeChatResource(tenantId: string, id = 'gpt4o-res'): Promise<string> {
  await createResource(db, {
    id,
    tenantId,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  return id;
}

describe('model + model_grant schema', () => {
  it('inserts a model with bigint token prices preserved and a unique name', async () => {
    const tenantId = await makeTenant();
    const resourceId = await makeChatResource(tenantId);
    const [m] = await db
      .insert(model)
      .values({
        name: 'gpt-4o',
        display: 'GPT-4o',
        resourceId,
        inputPrice: 30n,
        outputPrice: 60n,
        capabilities: { tools: true, vision: true },
      })
      .returning();
    expect(m?.inputPrice).toBe(30n);
    expect(m?.outputPrice).toBe(60n);
    expect(m?.visibility).toBe('public');
    expect(m?.modality).toBe('chat');
    expect(m?.capabilities).toEqual({ tools: true, vision: true });

    await expect(db.insert(model).values({ name: 'gpt-4o', resourceId })).rejects.toThrow();
  });

  it('grants a tenant-visibility model to one tenant, unique per (model, tenant)', async () => {
    const tenantId = await makeTenant();
    const resourceId = await makeChatResource(tenantId);
    const [m] = await db
      .insert(model)
      .values({ name: 'claude-x', resourceId, visibility: 'tenant' })
      .returning();
    if (!m) throw new Error('model insert returned no row');
    const modelId = m.id;

    await db.insert(modelGrant).values({ modelId, tenantId });
    await expect(db.insert(modelGrant).values({ modelId, tenantId })).rejects.toThrow();
  });
});
