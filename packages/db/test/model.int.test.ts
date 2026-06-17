import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createModel,
  createResource,
  getModelByName,
  grantModel,
  listModels,
  listVisibleModels,
  resolveModelForTenant,
  softDeleteModel,
  upsertModelsFromSync,
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
    const { rows: all } = await listModels(db, { limit: 200 });
    expect(all.map((m) => m.name).sort()).toEqual(['a', 'b']);
  });
});

describe('upsertModelsFromSync', () => {
  it('inserts new models with the default prices, then NEVER overwrites an existing price on re-sync', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-sync');

    // First sync: both models are new → inserted with default prices 3/7.
    const first = await upsertModelsFromSync(db, {
      resourceId,
      models: [
        { name: 'gpt-5.5', display: 'GPT-5.5', capabilities: { vision: true, tools: true } },
        { name: 'gpt-5.4-mini', display: 'GPT-5.4 mini', capabilities: { vision: false } },
      ],
      defaultInputPrice: 3n,
      defaultOutputPrice: 7n,
    });
    expect(first.created.sort()).toEqual(['gpt-5.4-mini', 'gpt-5.5']);
    expect(first.updated).toEqual([]);

    const inserted = await getModelByName(db, 'gpt-5.5');
    expect(inserted?.resourceId).toBe(resourceId);
    expect(inserted?.inputPrice).toBe(3n);
    expect(inserted?.outputPrice).toBe(7n);
    expect(inserted?.display).toBe('GPT-5.5');
    expect(inserted?.capabilities).toEqual({ vision: true, tools: true });
    expect(inserted?.visibility).toBe('public');
    expect(inserted?.status).toBe('active');

    // An operator hand-edits one model's price to 99/99 (the resale price).
    await db
      .update(schema.model)
      .set({ inputPrice: 99n, outputPrice: 99n })
      .where(eq(schema.model.name, 'gpt-5.5'));

    // Second sync with DIFFERENT defaults + one brand-new model.
    const second = await upsertModelsFromSync(db, {
      resourceId,
      models: [
        { name: 'gpt-5.5', display: 'GPT-5.5 v2', capabilities: { vision: true, tools: false } },
        { name: 'gpt-5.4', display: 'GPT-5.4' },
      ],
      defaultInputPrice: 30n,
      defaultOutputPrice: 70n,
    });
    expect(second.created).toEqual(['gpt-5.4']);
    expect(second.updated).toEqual(['gpt-5.5']);

    // The EXISTING model keeps its hand-edited 99/99 price — sync never overwrites it —
    // but its display + capabilities are refreshed.
    const existing = await getModelByName(db, 'gpt-5.5');
    expect(existing?.inputPrice).toBe(99n);
    expect(existing?.outputPrice).toBe(99n);
    expect(existing?.display).toBe('GPT-5.5 v2');
    expect(existing?.capabilities).toEqual({ vision: true, tools: false });

    // The NEW model got the SECOND sync's defaults (30/70).
    const fresh = await getModelByName(db, 'gpt-5.4');
    expect(fresh?.inputPrice).toBe(30n);
    expect(fresh?.outputPrice).toBe(70n);
  });
});

describe('createModel after soft-delete (partial unique on name)', () => {
  it('re-creates a soft-deleted name as a NEW live row, leaving the old row for audit', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-reuse');

    // Create + soft-delete a model.
    const original = await createModel(db, {
      name: 'gpt-reuse',
      resourceId,
      inputPrice: 5n,
    });
    const deletedName = await softDeleteModel(db, 'gpt-reuse');
    expect(deletedName).toBe('gpt-reuse');
    // The soft-deleted name drops out of the live lookup.
    expect(await getModelByName(db, 'gpt-reuse')).toBeUndefined();

    // Re-creating with the SAME name succeeds (partial unique frees the name)
    // and yields a NEW id distinct from the soft-deleted row.
    const recreated = await createModel(db, {
      name: 'gpt-reuse',
      resourceId,
      inputPrice: 11n,
    });
    expect(recreated.id).not.toBe(original.id);
    expect(recreated.deletedAt).toBeNull();

    // getModelByName returns the LIVE re-created row.
    const live = await getModelByName(db, 'gpt-reuse');
    expect(live?.id).toBe(recreated.id);
    expect(live?.inputPrice).toBe(11n);

    // The old soft-deleted row still exists (audit) — both rows share the name.
    const allRows = await db.select().from(schema.model).where(eq(schema.model.name, 'gpt-reuse'));
    expect(allRows).toHaveLength(2);
    const old = allRows.find((m) => m.id === original.id);
    expect(old?.deletedAt).not.toBeNull();
  });
});
