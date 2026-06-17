import {
  createModel,
  createModifier,
  createPricebookEntry,
  createRedemptionCode,
  createResource,
  createUpstreamChannel,
  deleteModelGrant,
  getChannelById,
  getModifierById,
  getPricebookEntryById,
  grantModel,
  listDifyBindings,
  listModelGrants,
  listRedemptionCodes,
  schema,
  softDeleteChannel,
  softDeleteDifyBinding,
  softDeleteModel,
  softDeleteModifier,
  softDeletePricebookEntry,
  updateDifyBinding,
  updateModel,
  updateModifier,
  updatePricebookEntry,
  updateResource,
  updateTenant,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const { difyBinding, tenant } = schema;

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
  await client`TRUNCATE TABLE dify_binding, model_grant, model, redemption_code, modifier, pricebook_entry, upstream_channel, resource_version, resource, account, tenant RESTART IDENTITY CASCADE`;
});

/** Insert a tenant + a chat resource the catalog rows can point at. */
async function seedResource(resourceId: string): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'crud' }).returning();
  if (!t) throw new Error('no tenant');
  await createResource(db, {
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  return t.id;
}

describe('D2: model update / soft-delete', () => {
  it('updates a model and stays a 404-after-soft-delete idempotently', async () => {
    await seedResource('m-res');
    await createModel(db, { name: 'gpt-x', resourceId: 'm-res', inputPrice: 3n, outputPrice: 7n });

    const patched = await updateModel(db, 'gpt-x', {
      display: 'GPT X',
      inputPrice: 30n,
      visibility: 'tenant',
      status: 'disabled',
    });
    expect(patched?.display).toBe('GPT X');
    expect(patched?.inputPrice).toBe(30n); // µcredit int preserved
    expect(patched?.outputPrice).toBe(7n); // untouched
    expect(patched?.visibility).toBe('tenant');
    expect(patched?.status).toBe('disabled');

    const deleted = await softDeleteModel(db, 'gpt-x');
    expect(deleted).toBe('gpt-x');
    // a second delete is undefined (idempotent), and update no longer matches.
    expect(await softDeleteModel(db, 'gpt-x')).toBeUndefined();
    expect(await updateModel(db, 'gpt-x', { status: 'active' })).toBeUndefined();
  });
});

describe('D2: model_grant list / hard-delete', () => {
  it('lists a grant then hard-deletes it (idempotent)', async () => {
    const tenantId = await seedResource('g-res');
    await createModel(db, { name: 'claude-g', resourceId: 'g-res', visibility: 'tenant' });
    await grantModel(db, 'claude-g', tenantId);

    const before = await listModelGrants(db, 'claude-g', { limit: 50 });
    expect(before.rows.map((r) => r.tenantId)).toContain(tenantId);

    const gid = await deleteModelGrant(db, 'claude-g', tenantId);
    expect(gid).toBeTypeOf('string');
    // hard delete: the row is gone, not soft-deleted (model_grant has no deleted_at).
    const after = await listModelGrants(db, 'claude-g', { limit: 50 });
    expect(after.rows).toHaveLength(0);
    expect(await deleteModelGrant(db, 'claude-g', tenantId)).toBeUndefined();
  });

  it('returns an empty grant page for an unknown model', async () => {
    const res = await listModelGrants(db, 'does-not-exist', { limit: 50 });
    expect(res.rows).toHaveLength(0);
  });
});

describe('D3: channel get / soft-delete (resource-scoped)', () => {
  it('gets a channel by id within its resource and soft-deletes it', async () => {
    await seedResource('c-res');
    const ch = await createUpstreamChannel(db, { resourceId: 'c-res', providerType: 'openai' });

    expect((await getChannelById(db, ch.id, 'c-res'))?.id).toBe(ch.id);
    // wrong resource → undefined (a channel of another resource is "not found").
    expect(await getChannelById(db, ch.id, 'other-res')).toBeUndefined();

    expect(await softDeleteChannel(db, ch.id, 'c-res')).toBe(ch.id);
    expect(await getChannelById(db, ch.id, 'c-res')).toBeUndefined();
    expect(await softDeleteChannel(db, ch.id, 'c-res')).toBeUndefined();
  });
});

describe('D3: pricebook get / update / soft-delete', () => {
  it('updates a pricebook entry and soft-deletes it', async () => {
    await seedResource('p-res');
    const pb = await createPricebookEntry(db, {
      resourceId: 'p-res',
      resourceVersion: 1,
      version: 1,
      method: 'fixed',
      timing: 'pre',
      spec: { method: 'fixed', amount: '1000000' },
    });

    expect((await getPricebookEntryById(db, pb.id))?.id).toBe(pb.id);

    // a credit amount inside spec arrives ALREADY in µcredits (controller converts).
    const patched = await updatePricebookEntry(db, pb.id, {
      timing: 'post',
      spec: { method: 'fixed', amount: '2000000' },
      active: false,
    });
    expect(patched?.timing).toBe('post');
    expect((patched?.spec as unknown as { amount: string }).amount).toBe('2000000');
    expect(patched?.active).toBe(false);

    expect(await softDeletePricebookEntry(db, pb.id)).toBe(pb.id);
    expect(await getPricebookEntryById(db, pb.id)).toBeUndefined();
    expect(await softDeletePricebookEntry(db, pb.id)).toBeUndefined();
  });
});

describe('D3: modifier get / update / soft-delete', () => {
  it('updates a modifier value (µcredits) and soft-deletes it', async () => {
    const mod = await createModifier(db, { scope: 'global', op: 'flat_off', value: 1_000_000n });
    expect((await getModifierById(db, mod.id))?.id).toBe(mod.id);

    const patched = await updateModifier(db, mod.id, {
      op: 'override_rate',
      value: 5_000_000n, // already µcredits
      priority: 9,
      active: false,
    });
    expect(patched?.op).toBe('override_rate');
    expect(patched?.value).toBe(5_000_000n);
    expect(patched?.priority).toBe(9);
    expect(patched?.active).toBe(false);

    expect(await softDeleteModifier(db, mod.id)).toBe(mod.id);
    expect(await getModifierById(db, mod.id)).toBeUndefined();
    expect(await softDeleteModifier(db, mod.id)).toBeUndefined();
  });
});

describe('D3: resource / tenant safe-field patch', () => {
  it('patches resource status (key fields untouched) and tenant isolation', async () => {
    const tenantId = await seedResource('r-res');

    const patchedRes = await updateResource(db, 'r-res', { status: 'disabled' });
    expect(patchedRes?.status).toBe('disabled');
    expect(patchedRes?.kind).toBe('model'); // immutable key field unchanged

    const patchedTenant = await updateTenant(db, tenantId, { isolationMode: 'schema' });
    expect(patchedTenant?.isolationMode).toBe('schema');
  });
});

describe('D4: redemption-code list (status filter)', () => {
  it('lists codes filtered by status', async () => {
    await createRedemptionCode(db, { code: 'AAAA', creditAmount: 5_000_000n });
    await createRedemptionCode(db, { code: 'BBBB', creditAmount: 5_000_000n });
    await client`UPDATE redemption_code SET status = 'redeemed' WHERE code = 'BBBB'`;

    const all = await listRedemptionCodes(db, {}, { limit: 50 });
    expect(all.rows.map((r) => r.code).sort()).toEqual(['AAAA', 'BBBB']);

    const unused = await listRedemptionCodes(db, { status: 'unused' }, { limit: 50 });
    expect(unused.rows.map((r) => r.code)).toEqual(['AAAA']);
  });
});

describe('D4: dify binding list / update / soft-delete', () => {
  it('updates the current binding and soft-deletes it', async () => {
    await seedResource('d-res');
    await db.insert(difyBinding).values({
      resourceId: 'd-res',
      resourceVersion: 1,
      mode: 'workflow',
      difyAppEndpoint: 'https://dify.example/v1',
      dslHash: 'h1',
      pricingModel: 'fixed',
    });

    const list = await listDifyBindings(db, { limit: 50 });
    expect(list.rows.map((r) => r.resourceId)).toContain('d-res');

    const patched = await updateDifyBinding(db, 'd-res', {
      endpoint: 'https://dify.example/v2',
      pricingModel: 'matrix',
    });
    expect(patched?.difyAppEndpoint).toBe('https://dify.example/v2');
    expect(patched?.pricingModel).toBe('matrix');

    expect(await softDeleteDifyBinding(db, 'd-res')).toBe('d-res');
    expect((await listDifyBindings(db, { limit: 50 })).rows).toHaveLength(0);
    expect(await softDeleteDifyBinding(db, 'd-res')).toBeUndefined();
  });
});
