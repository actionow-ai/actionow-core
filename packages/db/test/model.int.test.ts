import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createModel,
  createOfficialPrice,
  createResource,
  getModelByName,
  grantModel,
  listModels,
  listVisibleModels,
  resolveModelForTenant,
  softDeleteModel,
  updateModel,
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
  await client`TRUNCATE TABLE model_grant, model, official_model_price, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
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
      cachedInputPrice: null, // no cached rate set → null (用拆分计费 inactive)
      capabilities: { tools: true },
      paramProfile: null, // no frozen profile → null (passthrough == today; 模型参数绑定 Phase 1)
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

describe('upsertModelsFromSync (Track 2 auto-pricing)', () => {
  it('auto-prices a matched slug active, leaves an unmatched slug needs_pricing+disabled, preserves an existing model', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-sync');

    // The official catalog has gpt-4o (the matched slug), incl. a cached-input rate.
    await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
      cachedInputPricePer1m: 1_250_000n,
    });

    const first = await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      models: [
        // matches the catalog (case + date suffix normalized away).
        { name: 'GPT-4o-2024-05-13', display: 'GPT-4o', capabilities: { vision: true } },
        // no catalog row → never billable at 0.
        { name: 'gpt-unknown', display: 'Mystery' },
      ],
    });
    expect(first.created.sort()).toEqual(['GPT-4o-2024-05-13', 'gpt-unknown']);
    expect(first.summary).toContainEqual({ name: 'GPT-4o-2024-05-13', priced: 'official' });
    expect(first.summary).toContainEqual({ name: 'gpt-unknown', priced: 'needs_pricing' });

    // matched → official µUSD/1M, active, needs_pricing=false.
    const matched = await getModelByName(db, 'GPT-4o-2024-05-13');
    expect(matched?.inputPrice).toBe(2_500_000n);
    expect(matched?.outputPrice).toBe(10_000_000n);
    // 用拆分计费: the matched official cached-input rate is carried onto the model.
    expect(matched?.cachedInputPrice).toBe(1_250_000n);
    expect(matched?.status).toBe('active');
    expect(matched?.needsPricing).toBe(false);

    // resolveModelForTenant surfaces the cached rate to the relay (→ pricebook spec).
    const resolved = await resolveModelForTenant(db, 'GPT-4o-2024-05-13', owner);
    expect(resolved?.cachedInputPrice).toBe(1_250_000n);

    // unmatched → disabled + needs_pricing, prices 0 (NEVER active-with-0), no cached rate.
    const unmatched = await getModelByName(db, 'gpt-unknown');
    expect(unmatched?.inputPrice).toBe(0n);
    expect(unmatched?.outputPrice).toBe(0n);
    expect(unmatched?.cachedInputPrice).toBeNull();
    expect(unmatched?.status).toBe('disabled');
    expect(unmatched?.needsPricing).toBe(true);

    // An operator hand-prices the matched model differently (the resale price).
    await db
      .update(schema.model)
      .set({ inputPrice: 99n, outputPrice: 99n })
      .where(eq(schema.model.name, 'GPT-4o-2024-05-13'));

    // Re-sync: the existing model is preserved (price/status untouched), display refreshed.
    const second = await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      models: [
        { name: 'GPT-4o-2024-05-13', display: 'GPT-4o v2', capabilities: { vision: false } },
      ],
    });
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(['GPT-4o-2024-05-13']);
    const preserved = await getModelByName(db, 'GPT-4o-2024-05-13');
    expect(preserved?.inputPrice).toBe(99n); // never overwritten
    expect(preserved?.outputPrice).toBe(99n);
    expect(preserved?.display).toBe('GPT-4o v2'); // refreshed
    expect(preserved?.capabilities).toEqual({ vision: false });
  });

  it('leaves cached_input_price null when the matched official row has no cached rate (non-breaking)', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-nocache');

    // A matched official row WITHOUT cachedInputPricePer1m → model gets no cached rate.
    await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-nocache',
      inputPricePer1m: 2_000_000n,
      outputPricePer1m: 8_000_000n,
    });
    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      models: [{ name: 'gpt-nocache' }],
    });
    const m = await getModelByName(db, 'gpt-nocache');
    expect(m?.inputPrice).toBe(2_000_000n);
    expect(m?.cachedInputPrice).toBeNull();
  });

  it('uses explicit default prices for an unmatched slug and keeps it active (operator override)', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-default');

    const result = await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      models: [{ name: 'gpt-unmatched', display: 'X' }],
      defaultInputPrice: 3n,
      defaultOutputPrice: 7n,
    });
    expect(result.summary).toContainEqual({ name: 'gpt-unmatched', priced: 'default' });

    const m = await getModelByName(db, 'gpt-unmatched');
    expect(m?.inputPrice).toBe(3n);
    expect(m?.outputPrice).toBe(7n);
    expect(m?.status).toBe('active');
    expect(m?.needsPricing).toBe(false);
  });

  it('never bills 0: a needs_pricing/disabled synced model is not resolvable or visible', async () => {
    const owner = await makeTenant('owner');
    const resourceId = await makeChatResource(owner, 'r-never0');

    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      models: [{ name: 'gpt-needs-pricing' }],
    });
    const m = await getModelByName(db, 'gpt-needs-pricing');
    expect(m?.needsPricing).toBe(true);
    expect(m?.status).toBe('disabled');

    // status='active' filter keeps a disabled/needs_pricing model out of chat routing + listing.
    expect(await resolveModelForTenant(db, 'gpt-needs-pricing', owner)).toBeUndefined();
    const views = await listVisibleModels(db, owner);
    expect(views.map((v) => v.name)).not.toContain('gpt-needs-pricing');
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

describe('catalog facets (tags/maker/context_length/reasoning)', () => {
  it('round-trips on create + update, and surfaces in listVisibleModels', async () => {
    const t = await makeTenant();
    const r = await makeChatResource(t, 'glm-res');
    await createModel(db, {
      name: 'glm-5.2',
      resourceId: r,
      maker: 'z-ai',
      tags: ['推荐', '长上下文'],
      contextLength: 1_000_000,
      reasoning: 'optional',
    });

    const created = await getModelByName(db, 'glm-5.2');
    expect(created?.maker).toBe('z-ai');
    expect(created?.tags).toEqual(['推荐', '长上下文']);
    expect(created?.contextLength).toBe(1_000_000);
    expect(created?.reasoning).toBe('optional');

    // defaults: a model created without tags gets [] (not null).
    await createModel(db, { name: 'bare', resourceId: r });
    expect((await getModelByName(db, 'bare'))?.tags).toEqual([]);

    // update replaces tags + clears maker.
    await updateModel(db, 'glm-5.2', { tags: ['便宜'], maker: null, reasoning: 'always' });
    const patched = await getModelByName(db, 'glm-5.2');
    expect(patched?.tags).toEqual(['便宜']);
    expect(patched?.maker).toBeNull();
    expect(patched?.reasoning).toBe('always');

    // visible-models projection carries the facets.
    const visible = await listVisibleModels(db, t);
    const v = visible.find((m) => m.name === 'glm-5.2');
    expect(v?.maker).toBeNull();
    expect(v?.tags).toEqual(['便宜']);
    expect(v?.contextLength).toBe(1_000_000);
  });
});

describe('用拆分计费: model.cached_input_price round-trip (create / update / resolve)', () => {
  it('persists cachedInputPrice on create, clears it via null on update, defaults null', async () => {
    const t = await makeTenant();
    const r = await makeChatResource(t, 'cache-res');

    // create WITH a cached rate.
    await createModel(db, {
      name: 'gpt-cached',
      resourceId: r,
      visibility: 'public',
      inputPrice: 3_000_000n,
      outputPrice: 15_000_000n,
      cachedInputPrice: 300_000n,
    });
    const created = await getModelByName(db, 'gpt-cached');
    expect(created?.cachedInputPrice).toBe(300_000n);
    // resolveModelForTenant surfaces it to the relay.
    expect((await resolveModelForTenant(db, 'gpt-cached', t))?.cachedInputPrice).toBe(300_000n);

    // update to a different cached rate.
    await updateModel(db, 'gpt-cached', { cachedInputPrice: 150_000n });
    expect((await getModelByName(db, 'gpt-cached'))?.cachedInputPrice).toBe(150_000n);

    // null clears the cached rate (back to all-input-at-input billing).
    await updateModel(db, 'gpt-cached', { cachedInputPrice: null });
    expect((await getModelByName(db, 'gpt-cached'))?.cachedInputPrice).toBeNull();
    expect((await resolveModelForTenant(db, 'gpt-cached', t))?.cachedInputPrice).toBeNull();

    // a model created WITHOUT a cached rate defaults to null (non-breaking).
    await createModel(db, { name: 'gpt-bare-cache', resourceId: r });
    expect((await getModelByName(db, 'gpt-bare-cache'))?.cachedInputPrice).toBeNull();
  });
});
