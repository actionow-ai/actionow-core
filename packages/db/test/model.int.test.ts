import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createModel,
  createResource,
  grantModel,
  listModels,
  listVisibleModels,
  resolveModelForTenant,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant } = schema;

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

async function makeTenant(name = 'acme'): Promise<string> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

async function makeChatResource(tenantId: string, id: string): Promise<string> {
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

describe('resolveModelForTenant', () => {
  it('resolves a public model for any tenant with prices + capabilities', async () => {
    const owner = await makeTenant('owner');
    const caller = await makeTenant('caller');
    const resourceId = await makeChatResource(owner, 'r-public');
    await createModel(db, {
      name: 'gpt-4o',
      resourceId,
      visibility: 'public',
      inputPrice: 30n,
      outputPrice: 60n,
      capabilities: { tools: true },
    });

    const resolved = await resolveModelForTenant(db, 'gpt-4o', caller);
    expect(resolved).toEqual({
      modelId: expect.any(String),
      resourceId,
      inputPrice: 30n,
      outputPrice: 60n,
      capabilities: { tools: true },
    });
  });

  it('hides a tenant-visibility model from a tenant without a grant', async () => {
    const owner = await makeTenant('owner');
    const caller = await makeTenant('caller');
    const resourceId = await makeChatResource(owner, 'r-tenant');
    await createModel(db, { name: 'claude-x', resourceId, visibility: 'tenant' });

    expect(await resolveModelForTenant(db, 'claude-x', caller)).toBeUndefined();

    await grantModel(db, 'claude-x', caller);
    const resolved = await resolveModelForTenant(db, 'claude-x', caller);
    expect(resolved?.resourceId).toBe(resourceId);
  });

  it('does not resolve a disabled model', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-disabled');
    await createModel(db, { name: 'off', resourceId, status: 'disabled' });
    expect(await resolveModelForTenant(db, 'off', owner)).toBeUndefined();
  });
});

describe('listVisibleModels', () => {
  it('returns public models plus the tenant-granted ones, never ungranted tenant models', async () => {
    const owner = await makeTenant('owner');
    const caller = await makeTenant('caller');
    const rPub = await makeChatResource(owner, 'r1');
    const rGrant = await makeChatResource(owner, 'r2');
    const rHidden = await makeChatResource(owner, 'r3');
    await createModel(db, { name: 'pub', resourceId: rPub, visibility: 'public' });
    await createModel(db, { name: 'granted', resourceId: rGrant, visibility: 'tenant' });
    await createModel(db, { name: 'hidden', resourceId: rHidden, visibility: 'tenant' });
    await grantModel(db, 'granted', caller);

    const views = await listVisibleModels(db, caller);
    const names = views.map((v) => v.name).sort();
    expect(names).toEqual(['granted', 'pub']);
    const pub = views.find((v) => v.name === 'pub');
    expect(pub?.inputPrice).toBe(0n);
    expect(pub?.modality).toBe('chat');
  });
});

describe('admin listModels', () => {
  it('lists every model newest-first regardless of visibility', async () => {
    const owner = await makeTenant('owner');
    const r1 = await makeChatResource(owner, 'ra');
    const r2 = await makeChatResource(owner, 'rb');
    await createModel(db, { name: 'a', resourceId: r1, visibility: 'tenant' });
    await createModel(db, { name: 'b', resourceId: r2, visibility: 'public' });
    const all = await listModels(db);
    expect(all.map((m) => m.name).sort()).toEqual(['a', 'b']);
  });
});
