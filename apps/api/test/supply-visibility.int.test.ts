import type { ModelOperation } from '@actionow/contracts';
import {
  createDb,
  createSupplyChannel,
  createSupplyCredential,
  createSupplyModel,
  createSupplyOffering,
  createSupplyProvider,
  type Database,
  grantSupplyModel,
  listRoutableSupplyOfferings,
  listVisibleSupplyModels,
  resolveSupplyCredentialSecret,
  resolveSupplyModelByNameForTenant,
  revokeSupplyModel,
  schema,
  softDeleteSupplyChannel,
  softDeleteSupplyModel,
  softDeleteSupplyOffering,
  type SupplyChannelRow,
  type SupplyModelRow,
  type SupplyProviderRow,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Repo-level int tests for the 判据-2.1 GATE QUERIES (model-supply greenfield
 * 批次1): the §2.1 tenant-visibility gate (`listVisibleSupplyModels` /
 * `resolveSupplyModelByNameForTenant` — public 放行, granted 须 grant 命中,
 * 软删/下架排除), the §2.3 BYOK routability gate
 * (`listRoutableSupplyOfferings` — 租户私有渠道的供给项仅 owner 可路由), and
 * the §2.4 credential secret vault round-trip. Seeds via drizzle directly (no
 * HTTP) — the predicates under test live in the repository SQL.
 */

/** The vault master key credentials are encrypted with in these tests. */
const KEY_A = Buffer.alloc(32, 5).toString('base64');
/** A DIFFERENT valid 32-byte key — decryption with it must fail closed (undefined). */
const KEY_B = Buffer.alloc(32, 9).toString('base64');

const OPS: ModelOperation[] = [
  { operation: 'chat.completions', paradigms: ['sync'], slow: false, params: [] },
];

let container: StartedPostgreSqlContainer;
let db: Database;
let originalEncKey: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = createDb(container.getConnectionUri());
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
  originalEncKey = process.env.SECRET_ENCRYPTION_KEY;
}, 120_000);

afterAll(async () => {
  if (originalEncKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = originalEncKey;
  await container.stop();
});

afterEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE supply_model_grant, supply_offering, supply_credential, supply_model, supply_channel, supply_provider, supply_price_card, secret_material, secret_ref, tenant RESTART IDENTITY CASCADE`,
  );
});

async function mkTenant(name: string): Promise<{ id: string }> {
  const [t] = await db.insert(schema.tenant).values({ name }).returning();
  if (!t) throw new Error('mkTenant: insert returned no row');
  return t;
}

function mkModel(
  name: string,
  overrides: { status?: string; visibility?: string } = {},
): Promise<SupplyModelRow> {
  return createSupplyModel(db, {
    name,
    displayName: `Model ${name}`,
    modality: 'text',
    operations: OPS,
    status: overrides.status ?? 'active',
    visibility: overrides.visibility ?? 'public',
  });
}

function mkProvider(slug: string): Promise<SupplyProviderRow> {
  return createSupplyProvider(db, {
    slug,
    name: `Brand ${slug}`,
    defaultDialect: { ref: 'openai.chat', version: 'v1' },
  });
}

function mkChannel(
  providerId: string,
  overrides: { tenantId?: string | null; status?: string } = {},
): Promise<SupplyChannelRow> {
  return createSupplyChannel(db, {
    providerId,
    name: 'ch',
    authScheme: 'bearer',
    ...(overrides.tenantId !== undefined ? { tenantId: overrides.tenantId } : {}),
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
  });
}

describe('supply model visibility gate (§2.1 — listVisibleSupplyModels / resolveSupplyModelByNameForTenant)', () => {
  it('public passes for any tenant; granted needs a grant hit; soft-deleted vanishes', async () => {
    const tenantA = await mkTenant('tenant-a');
    const tenantB = await mkTenant('tenant-b');

    const pub = await mkModel('vis-pub');
    const granted = await mkModel('vis-granted', { visibility: 'granted' });
    const deleted = await mkModel('vis-deleted');
    await softDeleteSupplyModel(db, deleted.id);
    await grantSupplyModel(db, granted.id, tenantA.id);

    // list: A sees public + its granted model; B sees only public
    const forA = await listVisibleSupplyModels(db, tenantA.id);
    expect(forA.map((m) => m.id).sort()).toEqual([pub.id, granted.id].sort());
    const forB = await listVisibleSupplyModels(db, tenantB.id);
    expect(forB.map((m) => m.id)).toEqual([pub.id]);

    // resolve by external name: same gate, single-row form
    expect((await resolveSupplyModelByNameForTenant(db, 'vis-pub', tenantB.id))?.id).toBe(pub.id);
    expect((await resolveSupplyModelByNameForTenant(db, 'vis-granted', tenantA.id))?.id).toBe(
      granted.id,
    );
    // ungranted tenant: indistinguishable from a missing model
    expect(await resolveSupplyModelByNameForTenant(db, 'vis-granted', tenantB.id)).toBeUndefined();
    // soft-deleted: gone for everyone
    expect(await resolveSupplyModelByNameForTenant(db, 'vis-deleted', tenantA.id)).toBeUndefined();
    // unknown name: undefined
    expect(await resolveSupplyModelByNameForTenant(db, 'no-such', tenantA.id)).toBeUndefined();

    // revoking the grant closes the gate again (hard delete, idempotent)
    expect(await revokeSupplyModel(db, granted.id, tenantA.id)).toBeTypeOf('string');
    expect(await resolveSupplyModelByNameForTenant(db, 'vis-granted', tenantA.id)).toBeUndefined();
    expect((await listVisibleSupplyModels(db, tenantA.id)).map((m) => m.id)).toEqual([pub.id]);
    expect(await revokeSupplyModel(db, granted.id, tenantA.id)).toBeUndefined(); // second revoke: no-op
  });

  it('§10 shelf statuses: draft/disabled never surface; deprecated stays servable and listed', async () => {
    const tenant = await mkTenant('shelf-tenant');
    await mkModel('shelf-draft', { status: 'draft' });
    const active = await mkModel('shelf-active', { status: 'active' });
    const deprecated = await mkModel('shelf-deprecated', { status: 'deprecated' });
    await mkModel('shelf-disabled', { status: 'disabled' });

    expect(await resolveSupplyModelByNameForTenant(db, 'shelf-draft', tenant.id)).toBeUndefined();
    expect(
      await resolveSupplyModelByNameForTenant(db, 'shelf-disabled', tenant.id),
    ).toBeUndefined();
    expect((await resolveSupplyModelByNameForTenant(db, 'shelf-active', tenant.id))?.id).toBe(
      active.id,
    );
    // deprecated still resolves — the row carries status for the §10 header 预告 (批次3)
    const dep = await resolveSupplyModelByNameForTenant(db, 'shelf-deprecated', tenant.id);
    expect(dep?.id).toBe(deprecated.id);
    expect(dep?.status).toBe('deprecated');

    const listed = await listVisibleSupplyModels(db, tenant.id);
    expect(listed.map((m) => m.id).sort()).toEqual([active.id, deprecated.id].sort());
  });
});

describe('BYOK routability gate (§2.3 — listRoutableSupplyOfferings)', () => {
  it('tenant-private channel offerings route ONLY for the owner; platform channels for everyone', async () => {
    const tenantA = await mkTenant('byok-a');
    const tenantB = await mkTenant('byok-b');
    const provider = await mkProvider('byok-vendor');
    const model = await mkModel('byok-model');

    const platChannel = await mkChannel(provider.id); // tenant_id null = 平台自营
    const privChannel = await mkChannel(provider.id, { tenantId: tenantA.id }); // A's BYOK

    const platOffering = await createSupplyOffering(db, {
      modelId: model.id,
      channelId: platChannel.id,
      upstreamModelName: 'up-plat',
      fetchProfile: { mode: 'stream' },
      status: 'enabled',
      tier: 0,
    });
    const privOffering = await createSupplyOffering(db, {
      modelId: model.id,
      channelId: privChannel.id,
      upstreamModelName: 'up-priv',
      fetchProfile: { mode: 'stream' },
      status: 'enabled',
      tier: 1,
    });

    // owner A: both; the private offering carries its channel ownership
    const forA = await listRoutableSupplyOfferings(db, { modelId: model.id, tenantId: tenantA.id });
    expect(forA.map((o) => o.id)).toEqual([privOffering.id, platOffering.id]); // tier DESC
    expect(forA.map((o) => o.channelTenantId)).toEqual([tenantA.id, null]);
    expect(forA.every((o) => o.channelProviderId === provider.id)).toBe(true);

    // stranger B: ONLY the platform offering — A's private channel never leaks
    const forB = await listRoutableSupplyOfferings(db, { modelId: model.id, tenantId: tenantB.id });
    expect(forB.map((o) => o.id)).toEqual([platOffering.id]);
    expect(forB[0]?.channelTenantId).toBeNull();
  });

  it('filters non-enabled offerings, disabled channels, and soft-deleted rows', async () => {
    const tenant = await mkTenant('filter-tenant');
    const provider = await mkProvider('filter-vendor');
    const model = await mkModel('filter-model');

    // one channel per case — UNIQUE(model, channel) means each offering needs its own
    const chControl = await mkChannel(provider.id);
    const chDraft = await mkChannel(provider.id);
    const chProbing = await mkChannel(provider.id);
    const chDisabledOff = await mkChannel(provider.id);
    const chDisabledChan = await mkChannel(provider.id, { status: 'disabled' });
    const chDeletedOff = await mkChannel(provider.id);
    const chDeletedChan = await mkChannel(provider.id);

    const mkOffering = (channelId: string, status: string) =>
      createSupplyOffering(db, {
        modelId: model.id,
        channelId,
        upstreamModelName: 'up',
        fetchProfile: { mode: 'direct' },
        status,
      });

    const control = await mkOffering(chControl.id, 'enabled');
    await mkOffering(chDraft.id, 'draft'); // not enabled → filtered
    await mkOffering(chProbing.id, 'probing'); // not enabled → filtered
    await mkOffering(chDisabledOff.id, 'disabled'); // not enabled → filtered
    await mkOffering(chDisabledChan.id, 'enabled'); // channel disabled → filtered
    const deletedOffering = await mkOffering(chDeletedOff.id, 'enabled');
    await softDeleteSupplyOffering(db, deletedOffering.id); // offering soft-deleted → filtered
    await mkOffering(chDeletedChan.id, 'enabled');
    await softDeleteSupplyChannel(db, chDeletedChan.id); // channel soft-deleted → filtered

    const routable = await listRoutableSupplyOfferings(db, {
      modelId: model.id,
      tenantId: tenant.id,
    });
    expect(routable.map((o) => o.id)).toEqual([control.id]);
  });
});

describe('credential secret round-trip (§2.4 — vault-only material)', () => {
  it('bearer secret encrypts → resolves back to the original; a wrong/missing master key resolves undefined (never throws)', async () => {
    const provider = await mkProvider('vault-vendor');
    const channel = await mkChannel(provider.id);

    process.env.SECRET_ENCRYPTION_KEY = KEY_A;
    const secret = { scheme: 'bearer', api_key: 'sk-int-roundtrip-abcd' } as const;
    const credential = await createSupplyCredential(db, {
      channelId: channel.id,
      name: 'vault-key',
      secret,
      keyB64: KEY_A,
    });
    // the row carries only the redacted hint, never the material
    expect(credential.secretHint).toBe('…abcd');
    expect(JSON.stringify(credential)).not.toContain(secret.api_key);

    // round-trip with the right master key
    await expect(resolveSupplyCredentialSecret(db, credential.id)).resolves.toEqual(secret);

    // a DIFFERENT (tampered) master key: AES-GCM auth fails → undefined, no throw
    process.env.SECRET_ENCRYPTION_KEY = KEY_B;
    await expect(resolveSupplyCredentialSecret(db, credential.id)).resolves.toBeUndefined();

    // a missing master key: fail closed the same way
    delete process.env.SECRET_ENCRYPTION_KEY;
    await expect(resolveSupplyCredentialSecret(db, credential.id)).resolves.toBeUndefined();

    // restoring the key restores resolution (nothing was corrupted by the failures)
    process.env.SECRET_ENCRYPTION_KEY = KEY_A;
    await expect(resolveSupplyCredentialSecret(db, credential.id)).resolves.toEqual(secret);

    // unknown credential id → undefined
    await expect(
      resolveSupplyCredentialSecret(db, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});
