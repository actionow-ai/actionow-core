import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createOfficialPrice,
  createRouteGroup,
  createUser,
  schema,
  upsertModelSpec,
} from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

/**
 * E2E for the NEW-WORLD supply skeleton admin CRUD (model-supply greenfield
 * 批次1, design §2 — 完成判据 2.1): the six-entity chain provider → channel →
 * credential → price-card → model → offering under `/admin/supply/*`, plus the
 * cross-cutting gates — partial unique slots (软删释放), credential secret
 * redaction (vault-only), the needs_pricing gate (§10 永不 0 价上架, incl.
 * from-official minting), model grants, the api_key model allowlist (§2.6),
 * price-card immutability (versions), and the `@Audit` trail on writes.
 */

const ADMIN_SECRET = 'supply-admin-secret';
const ADMIN_EMAIL = 'admin-supply@actionow.local';
const ADMIN_PASSWORD = 'hunter2';
/** Base64 AES-256 master key for the credential vault (createSupplyCredential). */
const SECRET_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
/** A secret that must NEVER appear in any HTTP response or supply_credential row. */
const BEARER_SECRET = 'sk-supply-super-secret-value-f3a9';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let token: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      SECRET_ENCRYPTION_KEY: SECRET_KEY_B64,
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

beforeEach(async () => {
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  token = login.body.token as string;
});

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE request_idempotency, audit_log, supply_model_grant, supply_offering, supply_credential, supply_model, supply_channel, supply_provider, supply_price_card, official_model_price, model_spec, route_group, secret_material, secret_ref, api_key, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

// ----- fixture helpers (each `it` builds its own chain; afterEach truncates) -----

async function createProvider(slug: string): Promise<{ id: string }> {
  const res = await auth(request(app.getHttpServer()).post('/admin/supply/providers'))
    .send({ slug, name: `Brand ${slug}`, default_dialect: { ref: 'openai.chat', version: 'v1' } })
    .expect(201);
  return { id: res.body.id as string };
}

async function createChannel(
  providerId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await auth(request(app.getHttpServer()).post('/admin/supply/channels'))
    .send({ provider_id: providerId, name: 'main', auth_scheme: 'bearer', ...overrides })
    .expect(201);
  return { id: res.body.id as string };
}

async function createModel(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await auth(request(app.getHttpServer()).post('/admin/supply/models'))
    .send({
      name,
      display_name: `Model ${name}`,
      modality: 'text',
      operations: [{ operation: 'chat.completions', paradigms: ['sync', 'stream'] }],
      ...overrides,
    })
    .expect(201);
  return { id: res.body.id as string };
}

async function createPriceCard(name: string): Promise<{ id: string }> {
  const res = await auth(request(app.getHttpServer()).post('/admin/supply/price-cards'))
    .send({
      name,
      method: 'model_token',
      unit: 'tokens',
      spec: { method: 'model_token', inputPrice: 1_000_000, outputPrice: 2_000_000 },
      effective_at: new Date().toISOString(),
    })
    .expect(201);
  return { id: res.body.id as string };
}

async function createOffering(
  modelId: string,
  channelId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await auth(request(app.getHttpServer()).post('/admin/supply/offerings'))
    .send({
      model_id: modelId,
      channel_id: channelId,
      upstream_model_name: 'upstream-name',
      fetch_profile: { mode: 'stream' },
      ...overrides,
    })
    .expect(201);
  return { id: res.body.id as string };
}

async function createTenant(name: string): Promise<{ id: string }> {
  const res = await auth(request(app.getHttpServer()).post('/admin/tenants'))
    .send({ name })
    .expect(201);
  return { id: res.body.id as string };
}

/**
 * Newest audit row for one target via the badge endpoint, or undefined. The
 * `@Audit` interceptor writes fire-and-forget AFTER the response, so poll
 * until the latest row IS the expected action (same pattern as admin-bulk).
 */
async function latestAuditFor(
  targetType: string,
  id: string,
  expectedAction: string,
): Promise<{ action: string; actor_type: string } | undefined> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/audit-log/latest')
        .send({ target_type: targetType, ids: [id] }),
    ).expect(200);
    const row = (res.body as { target_id: string; action: string; actor_type: string }[]).find(
      (r) => r.target_id === id,
    );
    if (row?.action === expectedAction) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

describe('admin supply skeleton (六实体 CRUD, /admin/supply/*)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/supply/providers')
      .send({ slug: 'x', name: 'X', default_dialect: { ref: 'openai.chat', version: 'v1' } })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('drives the full chain: provider → channel → credential → price-card → model → offering (create/get/patch/soft-delete/404)', async () => {
    // provider
    const provRes = await auth(request(app.getHttpServer()).post('/admin/supply/providers'))
      .send({
        slug: 'openai',
        name: 'OpenAI',
        default_dialect: { ref: 'openai.chat', version: 'v1' },
        region: 'us',
      })
      .expect(201);
    const providerId = provRes.body.id as string;
    expect(provRes.body.slug).toBe('openai');
    expect(provRes.body.default_dialect).toEqual({ ref: 'openai.chat', version: 'v1' });

    const provGot = await auth(
      request(app.getHttpServer()).get(`/admin/supply/providers/${providerId}`),
    ).expect(200);
    expect(provGot.body.region).toBe('us');

    const provPatched = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/providers/${providerId}`),
    )
      .send({ name: 'OpenAI Inc', region: null })
      .expect(200);
    expect(provPatched.body.name).toBe('OpenAI Inc');
    expect(provPatched.body.region).toBeNull();
    expect(provPatched.body.slug).toBe('openai'); // untouched

    // channel (under the live provider; unknown provider → 400)
    const chanRes = await auth(request(app.getHttpServer()).post('/admin/supply/channels'))
      .send({ provider_id: providerId, name: 'main', auth_scheme: 'bearer', tags: ['tier-1'] })
      .expect(201);
    const channelId = chanRes.body.id as string;
    expect(chanRes.body.provider_id).toBe(providerId);
    expect(chanRes.body.tenant_id).toBeNull(); // 平台自营 by default
    expect(chanRes.body.status).toBe('active');
    expect(chanRes.body.tags).toEqual(['tier-1']);

    await auth(request(app.getHttpServer()).post('/admin/supply/channels'))
      .send({ provider_id: NIL_UUID, name: 'ghost', auth_scheme: 'bearer' })
      .expect(400);

    const chanPatched = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/channels/${channelId}`),
    )
      .send({ base_url: 'https://api.openai.com/v1', status: 'disabled' })
      .expect(200);
    expect(chanPatched.body.base_url).toBe('https://api.openai.com/v1');
    expect(chanPatched.body.status).toBe('disabled');

    // credential (secret vaulted; redaction asserted in its own describe)
    const credRes = await auth(request(app.getHttpServer()).post('/admin/supply/credentials'))
      .send({
        channel_id: channelId,
        name: 'key-1',
        secret: { scheme: 'bearer', api_key: BEARER_SECRET },
        quota: { rpm: 600, tpm: null, max_concurrency: 8 },
      })
      .expect(201);
    const credentialId = credRes.body.id as string;
    expect(credRes.body.quota).toEqual({ rpm: 600, tpm: null, max_concurrency: 8 });

    const cooldown = new Date(Date.now() + 60_000).toISOString();
    const credPatched = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/credentials/${credentialId}`),
    )
      .send({ name: 'key-1-rotated-label', cooldown_until: cooldown })
      .expect(200);
    expect(credPatched.body.name).toBe('key-1-rotated-label');
    expect(credPatched.body.cooldown_until).toBe(cooldown);

    const credCleared = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/credentials/${credentialId}`),
    )
      .send({ cooldown_until: null })
      .expect(200);
    expect(credCleared.body.cooldown_until).toBeNull();

    // price card
    const card = await createPriceCard('gpt-x sale v1');
    const cardGot = await auth(
      request(app.getHttpServer()).get(`/admin/supply/price-cards/${card.id}`),
    ).expect(200);
    expect(cardGot.body.version).toBe(1);
    expect(cardGot.body.method).toBe('model_token');

    // model (draft by default; operations round-trip with frozen defaults)
    const modelRes = await auth(request(app.getHttpServer()).post('/admin/supply/models'))
      .send({
        name: 'gpt-x',
        display_name: 'GPT X',
        modality: 'text',
        operations: [{ operation: 'chat.completions', paradigms: ['sync', 'stream'] }],
        capabilities: ['tool-call'],
      })
      .expect(201);
    const modelId = modelRes.body.id as string;
    expect(modelRes.body.status).toBe('draft');
    expect(modelRes.body.visibility).toBe('public');
    expect(modelRes.body.price_card_id).toBeNull();
    expect(modelRes.body.operations).toEqual([
      { operation: 'chat.completions', paradigms: ['sync', 'stream'], slow: false, params: [] },
    ]);

    const modelPatched = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/models/${modelId}`),
    )
      .send({ display_name: 'GPT X Ultra', max_run_time_seconds: 900 })
      .expect(200);
    expect(modelPatched.body.display_name).toBe('GPT X Ultra');
    expect(modelPatched.body.max_run_time_seconds).toBe(900);
    expect(modelPatched.body.name).toBe('gpt-x'); // untouched

    // offering (the (model × channel) hard binding; unknown side → 400)
    const offRes = await auth(request(app.getHttpServer()).post('/admin/supply/offerings'))
      .send({
        model_id: modelId,
        channel_id: channelId,
        upstream_model_name: 'gpt-x-2026-01-01',
        fetch_profile: { mode: 'stream' },
        cost_price_card_id: card.id,
        weight: 5,
        tier: 2,
      })
      .expect(201);
    const offeringId = offRes.body.id as string;
    expect(offRes.body.status).toBe('draft');
    expect(offRes.body.upstream_model_name).toBe('gpt-x-2026-01-01');
    expect(offRes.body.fetch_profile).toEqual({ mode: 'stream' });
    expect(offRes.body.weight).toBe(5);
    expect(offRes.body.tier).toBe(2);

    await auth(request(app.getHttpServer()).post('/admin/supply/offerings'))
      .send({
        model_id: NIL_UUID,
        channel_id: channelId,
        upstream_model_name: 'x',
        fetch_profile: { mode: 'direct' },
      })
      .expect(400);

    // status PATCH stays open for non-enabled states ('enabled' is gate-only
    // since 批次5 slice1 — covered by the lifecycle describe below).
    const offPatched = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/offerings/${offeringId}`),
    )
      .send({ status: 'disabled', weight: 9 })
      .expect(200);
    expect(offPatched.body.status).toBe('disabled');
    expect(offPatched.body.weight).toBe(9);
    expect(offPatched.body.model_id).toBe(modelId); // identity untouched

    // soft-delete the whole chain → each GET flips to 404
    for (const [path, id] of [
      ['offerings', offeringId],
      ['models', modelId],
      ['credentials', credentialId],
      ['channels', channelId],
      ['providers', providerId],
      ['price-cards', card.id],
    ] as const) {
      await auth(request(app.getHttpServer()).delete(`/admin/supply/${path}/${id}`)).expect(204);
      const gone = await auth(
        request(app.getHttpServer()).get(`/admin/supply/${path}/${id}`),
      ).expect(404);
      expect(gone.body.error.code).toBe('resource_not_found');
      // repeated DELETE of an already-soft-deleted row → 404 (idempotent reads, explicit delete)
      await auth(request(app.getHttpServer()).delete(`/admin/supply/${path}/${id}`)).expect(404);
    }
  });

  it('lists with the Track-B envelope + filters (channels by provider/tenant, credentials by channel, models by status, offerings by model/channel/status)', async () => {
    const p1 = await createProvider('vendor-a');
    const p2 = await createProvider('vendor-b');
    const tenant = await createTenant('byok-tenant');
    const c1 = await createChannel(p1.id, { name: 'plat' });
    const c2 = await createChannel(p2.id, { name: 'byok', tenant_id: tenant.id });
    await auth(request(app.getHttpServer()).post('/admin/supply/credentials'))
      .send({ channel_id: c1.id, name: 'k1', secret: { scheme: 'bearer', api_key: 'sk-list-1' } })
      .expect(201);
    const card = await createPriceCard('list-card');
    const m1 = await createModel('list-m1');
    const m2 = await createModel('list-m2', { status: 'active', price_card_id: card.id });
    const o1 = await createOffering(m1.id, c1.id);
    // offerings are born `draft` (the create schema has no status); flip one to
    // `disabled` via PATCH for the status filter ('enabled' is gate-only, 批次5).
    const o2 = await createOffering(m1.id, c2.id);
    await auth(request(app.getHttpServer()).patch(`/admin/supply/offerings/${o2.id}`))
      .send({ status: 'disabled' })
      .expect(200);

    // providers list — the uniform envelope
    const provList = await auth(request(app.getHttpServer()).get('/admin/supply/providers')).expect(
      200,
    );
    expect(provList.body).toHaveProperty('data');
    expect(provList.body).toHaveProperty('next_cursor');
    expect(provList.body).toHaveProperty('has_more');
    expect((provList.body.data as { slug: string }[]).map((r) => r.slug).sort()).toEqual([
      'vendor-a',
      'vendor-b',
    ]);

    // channels ?provider_id= / ?tenant_id=
    const byProvider = await auth(
      request(app.getHttpServer()).get(`/admin/supply/channels?provider_id=${p1.id}`),
    ).expect(200);
    expect((byProvider.body.data as { id: string }[]).map((r) => r.id)).toEqual([c1.id]);
    const byTenant = await auth(
      request(app.getHttpServer()).get(`/admin/supply/channels?tenant_id=${tenant.id}`),
    ).expect(200);
    expect((byTenant.body.data as { id: string; tenant_id: string }[]).map((r) => r.id)).toEqual([
      c2.id,
    ]);
    expect(byTenant.body.data[0].tenant_id).toBe(tenant.id);

    // credentials ?channel_id=
    const credsByChannel = await auth(
      request(app.getHttpServer()).get(`/admin/supply/credentials?channel_id=${c1.id}`),
    ).expect(200);
    expect(credsByChannel.body.data).toHaveLength(1);
    const credsByOther = await auth(
      request(app.getHttpServer()).get(`/admin/supply/credentials?channel_id=${c2.id}`),
    ).expect(200);
    expect(credsByOther.body.data).toHaveLength(0);

    // models ?status=
    const draftModels = await auth(
      request(app.getHttpServer()).get('/admin/supply/models?status=draft'),
    ).expect(200);
    expect((draftModels.body.data as { id: string }[]).map((r) => r.id)).toEqual([m1.id]);
    const activeModels = await auth(
      request(app.getHttpServer()).get('/admin/supply/models?status=active'),
    ).expect(200);
    expect((activeModels.body.data as { id: string }[]).map((r) => r.id)).toEqual([m2.id]);

    // offerings ?model_id= / ?channel_id= / ?status=
    const offsByModel = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings?model_id=${m1.id}`),
    ).expect(200);
    expect((offsByModel.body.data as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [o1.id, o2.id].sort(),
    );
    const offsByChannel = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings?channel_id=${c2.id}`),
    ).expect(200);
    expect((offsByChannel.body.data as { id: string }[]).map((r) => r.id)).toEqual([o2.id]);
    const offsDisabled = await auth(
      request(app.getHttpServer()).get('/admin/supply/offerings?status=disabled'),
    ).expect(200);
    expect((offsDisabled.body.data as { id: string }[]).map((r) => r.id)).toEqual([o2.id]);
  });

  it('walks price-card pages with limit + cursor (keyset envelope)', async () => {
    await createPriceCard('page-1');
    await createPriceCard('page-2');
    await createPriceCard('page-3');

    const first = await auth(
      request(app.getHttpServer()).get('/admin/supply/price-cards?limit=2'),
    ).expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.has_more).toBe(true);
    expect(first.body.next_cursor).not.toBeNull();

    const second = await auth(
      request(app.getHttpServer()).get(
        `/admin/supply/price-cards?limit=2&cursor=${encodeURIComponent(first.body.next_cursor as string)}`,
      ),
    ).expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.has_more).toBe(false);
    expect(second.body.next_cursor).toBeNull();

    const firstIds = (first.body.data as { id: string }[]).map((r) => r.id);
    const secondIds = (second.body.data as { id: string }[]).map((r) => r.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(3); // no overlap, full coverage
  });
});

describe('partial unique constraints (软删释放槽位)', () => {
  it('provider slug: duplicate live → 400; soft-delete frees the slug', async () => {
    const first = await createProvider('dup-vendor');
    const dup = await auth(request(app.getHttpServer()).post('/admin/supply/providers'))
      .send({ slug: 'dup-vendor', name: 'Again', default_dialect: { ref: 'd', version: '1' } })
      .expect(400);
    expect(dup.body.error.code).toBe('invalid_input');

    await auth(request(app.getHttpServer()).delete(`/admin/supply/providers/${first.id}`)).expect(
      204,
    );
    // The partial unique index (WHERE deleted_at IS NULL) frees the slot.
    await createProvider('dup-vendor');
  });

  it('model external name: duplicate live → 400; soft-delete frees the name', async () => {
    const first = await createModel('dup-model');
    const dup = await auth(request(app.getHttpServer()).post('/admin/supply/models'))
      .send({
        name: 'dup-model',
        display_name: 'Again',
        modality: 'text',
        operations: [{ operation: 'chat.completions', paradigms: ['sync'] }],
      })
      .expect(400);
    expect(dup.body.error.code).toBe('invalid_input');

    await auth(request(app.getHttpServer()).delete(`/admin/supply/models/${first.id}`)).expect(204);
    await createModel('dup-model');
  });

  it('offering (model, channel): duplicate live → 400; soft-delete frees the pair', async () => {
    const provider = await createProvider('pair-vendor');
    const channel = await createChannel(provider.id);
    const model = await createModel('pair-model');
    const first = await createOffering(model.id, channel.id);

    const dup = await auth(request(app.getHttpServer()).post('/admin/supply/offerings'))
      .send({
        model_id: model.id,
        channel_id: channel.id,
        upstream_model_name: 'other-upstream',
        fetch_profile: { mode: 'direct' },
      })
      .expect(400);
    expect(dup.body.error.code).toBe('invalid_input');

    await auth(request(app.getHttpServer()).delete(`/admin/supply/offerings/${first.id}`)).expect(
      204,
    );
    await createOffering(model.id, channel.id);
  });
});

describe('credential secret redaction (the secret never leaves the vault)', () => {
  it('create/get/list responses carry secret_hint only; the vault row is ciphertext', async () => {
    const provider = await createProvider('sec-vendor');
    const channel = await createChannel(provider.id);

    const created = await auth(request(app.getHttpServer()).post('/admin/supply/credentials'))
      .send({
        channel_id: channel.id,
        name: 'sec-key',
        secret: { scheme: 'bearer', api_key: BEARER_SECRET },
      })
      .expect(201);
    const credentialId = created.body.id as string;
    expect(created.body.secret_hint).toBe(`…${BEARER_SECRET.slice(-4)}`);
    expect(created.body).not.toHaveProperty('secret');
    expect(JSON.stringify(created.body)).not.toContain(BEARER_SECRET);

    const got = await auth(
      request(app.getHttpServer()).get(`/admin/supply/credentials/${credentialId}`),
    ).expect(200);
    expect(JSON.stringify(got.body)).not.toContain(BEARER_SECRET);

    const listed = await auth(request(app.getHttpServer()).get('/admin/supply/credentials')).expect(
      200,
    );
    expect(listed.body.data).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(BEARER_SECRET);

    // The supply_credential row itself never stores plaintext…
    const credRows = await db.select().from(schema.supplyCredential);
    expect(JSON.stringify(credRows)).not.toContain(BEARER_SECRET);
    // …and the vault material is ciphertext, not the secret.
    const matRows = await db.select().from(schema.secretMaterial);
    expect(matRows).toHaveLength(1);
    expect(matRows[0]?.material).not.toContain(BEARER_SECRET);
  });

  it('secret scheme must match the channel auth_scheme → 400', async () => {
    const provider = await createProvider('mismatch-vendor');
    const channel = await createChannel(provider.id, { auth_scheme: 'bearer' });

    const res = await auth(request(app.getHttpServer()).post('/admin/supply/credentials'))
      .send({
        channel_id: channel.id,
        name: 'bad-scheme',
        secret: { scheme: 'x_api_key', api_key: 'sk-wrong-shape' },
      })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('auth_scheme');
  });
});

describe('needs_pricing gate (§10 永不 0 价上架)', () => {
  it('active without a sale card → 400 on create, on status patch, and on clearing the card', async () => {
    // create born-active without a card → 400
    const born = await auth(request(app.getHttpServer()).post('/admin/supply/models'))
      .send({
        name: 'unpriced-active',
        display_name: 'Unpriced',
        modality: 'text',
        operations: [{ operation: 'chat.completions', paradigms: ['sync'] }],
        status: 'active',
      })
      .expect(400);
    expect(born.body.error.message).toContain('needs_pricing');

    // draft → PATCH active without a card → 400
    const model = await createModel('needs-pricing-m');
    const patched = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/models/${model.id}`),
    )
      .send({ status: 'active' })
      .expect(400);
    expect(patched.body.error.message).toContain('needs_pricing');

    // bind a card + active in one PATCH → 200
    const card = await createPriceCard('unlock-card');
    const unlocked = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/models/${model.id}`),
    )
      .send({ status: 'active', price_card_id: card.id })
      .expect(200);
    expect(unlocked.body.status).toBe('active');
    expect(unlocked.body.price_card_id).toBe(card.id);

    // clearing the card while active → 400 (the gate checks the EFFECTIVE state)
    const cleared = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/models/${model.id}`),
    )
      .send({ price_card_id: null })
      .expect(400);
    expect(cleared.body.error.message).toContain('needs_pricing');
  });

  it('from-official mints + binds the sale card; no official match → 400 needs_pricing', async () => {
    const model = await createModel('gpt-official-x');
    // Seed the official catalog with a live billable row for (openai, gpt-official-x).
    await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-official-x',
      inputPricePer1m: 1_250_000n,
      outputPricePer1m: 10_000_000n,
      billingEligible: true,
    });

    const minted = await auth(
      request(app.getHttpServer()).post(
        `/admin/supply/models/${model.id}/price-card/from-official`,
      ),
    )
      .send({ provider: 'openai' })
      .expect(201);
    expect(minted.body.method).toBe('model_token');
    expect(minted.body.spec).toEqual({
      method: 'model_token',
      inputPrice: 1_250_000,
      outputPrice: 10_000_000,
    });
    expect(minted.body.version).toBe(1);

    // the model is re-pointed at the minted card
    const got = await auth(
      request(app.getHttpServer()).get(`/admin/supply/models/${model.id}`),
    ).expect(200);
    expect(got.body.price_card_id).toBe(minted.body.id);

    // …and the card unlocks active
    await auth(request(app.getHttpServer()).patch(`/admin/supply/models/${model.id}`))
      .send({ status: 'active' })
      .expect(200);

    // no official match for this provider → 400 needs_pricing
    const noMatch = await auth(
      request(app.getHttpServer()).post(
        `/admin/supply/models/${model.id}/price-card/from-official`,
      ),
    )
      .send({ provider: 'no-such-vendor' })
      .expect(400);
    expect(noMatch.body.error.message).toContain('needs_pricing');
  });
});

describe('model grants (§2.1 visibility gate admin surface)', () => {
  it('grant → list → revoke round-trip; grant and revoke are both idempotent', async () => {
    const model = await createModel('granted-model', { visibility: 'granted' });
    const tenant = await createTenant('grantee');

    await auth(request(app.getHttpServer()).post(`/admin/supply/models/${model.id}/grants`))
      .send({ tenant_id: tenant.id })
      .expect(201);
    // duplicate grant → still 201 (onConflictDoNothing), no second row
    await auth(request(app.getHttpServer()).post(`/admin/supply/models/${model.id}/grants`))
      .send({ tenant_id: tenant.id })
      .expect(201);

    const listed = await auth(
      request(app.getHttpServer()).get(`/admin/supply/models/${model.id}/grants`),
    ).expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].tenant_id).toBe(tenant.id);
    expect(listed.body.data[0].model_id).toBe(model.id);

    await auth(
      request(app.getHttpServer()).delete(`/admin/supply/models/${model.id}/grants/${tenant.id}`),
    ).expect(204);
    // revoking an absent grant is a no-op 204 (idempotent)
    await auth(
      request(app.getHttpServer()).delete(`/admin/supply/models/${model.id}/grants/${tenant.id}`),
    ).expect(204);

    const after = await auth(
      request(app.getHttpServer()).get(`/admin/supply/models/${model.id}/grants`),
    ).expect(200);
    expect(after.body.data).toHaveLength(0);
  });

  it('grant: unknown model → 404, unknown tenant → 400', async () => {
    const tenant = await createTenant('lonely-tenant');
    await auth(request(app.getHttpServer()).post(`/admin/supply/models/${NIL_UUID}/grants`))
      .send({ tenant_id: tenant.id })
      .expect(404);

    const model = await createModel('grant-target');
    await auth(request(app.getHttpServer()).post(`/admin/supply/models/${model.id}/grants`))
      .send({ tenant_id: NIL_UUID })
      .expect(400);
  });
});

describe('api_key model allowlist (§2.6 — model-dimension whitelist)', () => {
  it('replaces the allowlist (echo + db read-back); [] = allow-all; unknown key → 404', async () => {
    const tenant = await createTenant('key-owner');
    const keyRes = await auth(request(app.getHttpServer()).post('/admin/api-keys'))
      .send({ tenantId: tenant.id })
      .expect(201);
    const keyId = keyRes.body.id as string;

    // fresh key defaults to [] (allow ALL models)
    const [freshRow] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, keyId));
    expect(freshRow?.modelAllowlist).toEqual([]);

    const set = await auth(
      request(app.getHttpServer()).patch(`/admin/api-keys/${keyId}/model-allowlist`),
    )
      .send({ models: ['gpt-x', 'claude-y'] })
      .expect(200);
    expect(set.body).toEqual({ models: ['gpt-x', 'claude-y'] });

    const [setRow] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, keyId));
    expect(setRow?.modelAllowlist).toEqual(['gpt-x', 'claude-y']);

    // replace back to [] (allow-all semantics, mirroring resource_allowlist)
    const clear = await auth(
      request(app.getHttpServer()).patch(`/admin/api-keys/${keyId}/model-allowlist`),
    )
      .send({ models: [] })
      .expect(200);
    expect(clear.body).toEqual({ models: [] });
    const [clearedRow] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, keyId));
    expect(clearedRow?.modelAllowlist).toEqual([]);

    // unknown key → 404
    await auth(request(app.getHttpServer()).patch(`/admin/api-keys/${NIL_UUID}/model-allowlist`))
      .send({ models: ['gpt-x'] })
      .expect(404);
  });
});

describe('price-card immutability (versions are the only price-change path)', () => {
  it('POST /versions mints version+1 as a NEW row; the base row is untouched', async () => {
    const base = await createPriceCard('versioned-card');

    const v2 = await auth(
      request(app.getHttpServer()).post(`/admin/supply/price-cards/${base.id}/versions`),
    )
      .send({ spec: { method: 'model_token', inputPrice: 3_000_000, outputPrice: 6_000_000 } })
      .expect(201);
    expect(v2.body.version).toBe(2);
    expect(v2.body.id).not.toBe(base.id); // a NEW row, not an update
    expect(v2.body.spec.inputPrice).toBe(3_000_000);
    expect(v2.body.name).toBe('versioned-card'); // base fields carry over

    // the base card is byte-identical to before (immutable once effective)
    const baseGot = await auth(
      request(app.getHttpServer()).get(`/admin/supply/price-cards/${base.id}`),
    ).expect(200);
    expect(baseGot.body.version).toBe(1);
    expect(baseGot.body.spec.inputPrice).toBe(1_000_000);
  });

  it('a version patch that desyncs method vs spec → 400', async () => {
    const base = await createPriceCard('desync-card');
    const res = await auth(
      request(app.getHttpServer()).post(`/admin/supply/price-cards/${base.id}/versions`),
    )
      .send({ method: 'fixed' }) // base spec stays model_token → effective pair desyncs
      .expect(400);
    expect(res.body.error.message).toContain('method must equal spec.method');
  });
});

describe('audit trail (@Audit on supply writes, fire-and-forget)', () => {
  it('supply_provider.create and supply_model.grant land audit_log rows (polled)', async () => {
    const provider = await createProvider('audited-vendor');
    const created = await latestAuditFor('supply_provider', provider.id, 'supply_provider.create');
    expect(created).toBeDefined();
    expect(created?.action).toBe('supply_provider.create');
    expect(created?.actor_type).toBe('operator'); // a platform-admin JWT is an OPERATOR actor

    const model = await createModel('audited-model', { visibility: 'granted' });
    const tenant = await createTenant('audited-tenant');
    await auth(request(app.getHttpServer()).post(`/admin/supply/models/${model.id}/grants`))
      .send({ tenant_id: tenant.id })
      .expect(201);
    const granted = await latestAuditFor('supply_model_grant', model.id, 'supply_model.grant');
    expect(granted).toBeDefined();
    expect(granted?.action).toBe('supply_model.grant');
  });
});

describe('offering lifecycle — golden probe + enable 双门 (批次5 slice1, §10/§2.5)', () => {
  /** A fake OpenAI-shaped upstream the REAL builtin `openai@1.0.0` dialect probes against. */
  let upstream: Server;
  let upstreamUrl: string;
  let upstreamHits: number;
  let savedEncryptionKey: string | undefined;

  beforeAll(async () => {
    // The vault decrypt path (resolveSecretRef) reads process.env directly —
    // the injected ENV override does not reach it (the admin-crud pattern).
    savedEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    process.env.SECRET_ENCRYPTION_KEY = SECRET_KEY_B64;
    upstream = createServer((req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${String(addr.port)}/v1`;
  });

  afterAll(async () => {
    if (savedEncryptionKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = savedEncryptionKey;
    await new Promise<void>((resolve, reject) => {
      upstream.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  beforeEach(() => {
    upstreamHits = 0;
  });

  /** provider (REAL builtin openai dialect) → channel (fake upstream) → bearer credential. */
  async function createProbeChain(slug: string): Promise<{ channelId: string }> {
    const providerRes = await auth(request(app.getHttpServer()).post('/admin/supply/providers'))
      .send({
        slug,
        name: `Brand ${slug}`,
        default_dialect: { ref: 'openai', version: '1.0.0' },
      })
      .expect(201);
    const channel = await createChannel(providerRes.body.id as string, {
      base_url: upstreamUrl,
    });
    await auth(request(app.getHttpServer()).post('/admin/supply/credentials'))
      .send({
        channel_id: channel.id,
        name: 'probe-key',
        secret: { scheme: 'bearer', api_key: BEARER_SECRET },
      })
      .expect(201);
    return { channelId: channel.id };
  }

  it('PATCH cannot set status=enabled (裸改被拦 — enable is gate-only)', async () => {
    const { channelId } = await createProbeChain('gate-vendor-patch');
    const model = await createModel('gate-model-patch');
    const offering = await createOffering(model.id, channelId, {
      fetch_profile: { mode: 'direct' },
    });

    const res = await auth(
      request(app.getHttpServer()).patch(`/admin/supply/offerings/${offering.id}`),
    )
      .send({ status: 'enabled' })
      .expect(400);
    expect(res.body.error.message).toContain('/enable');

    // disabled stays a plain PATCH (不收新请求 is immediate — routing filters on enabled).
    await auth(request(app.getHttpServer()).patch(`/admin/supply/offerings/${offering.id}`))
      .send({ status: 'disabled' })
      .expect(200);
    expect(upstreamHits).toBe(0);
  });

  it('enable rejects a violating config with STRUCTURED violations — and never spends probe budget', async () => {
    const { channelId } = await createProbeChain('gate-vendor-violations');
    // No sale price card (needs_pricing) + an operator widen (operator_subset).
    const model = await createModel('gate-model-violations', {
      operations: [
        {
          operation: 'chat.completions',
          paradigms: ['sync'],
          params: [{ name: 'style', type: 'enum', values: ['natural'], billingRelevant: false }],
        },
      ],
    });
    const offering = await createOffering(model.id, channelId, {
      fetch_profile: { mode: 'direct' },
      param_declarations: [
        { param: 'style', origin: 'upstream', rule: { kind: 'domain', values: ['natural'] } },
        { param: 'style', origin: 'operator', rule: { kind: 'fixed', value: 'vivid' } },
      ],
    });

    const res = await auth(
      request(app.getHttpServer()).post(`/admin/supply/offerings/${offering.id}/enable`),
    ).expect(200);
    expect(res.body.enabled).toBe(false);
    const gates = (res.body.violations as { gate: string; param?: string }[]).map((v) => v.gate);
    expect(gates).toContain('needs_pricing');
    expect(gates).toContain('operator_subset');
    // Config gates run FIRST: the golden probe (and its budget) was never reached.
    expect(res.body.probe).toBeUndefined();
    expect(upstreamHits).toBe(0);
    // Status untouched — still draft.
    const got = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings/${offering.id}`),
    ).expect(200);
    expect(got.body.status).toBe('draft');
  });

  it('enable passes the 4 config gates + a REAL golden probe → enabled (§10 通过才可 enable)', async () => {
    const { channelId } = await createProbeChain('gate-vendor-happy');
    const card = await createPriceCard('probe-sale-card');
    const model = await createModel('gate-model-happy', {
      price_card_id: card.id,
      operations: [{ operation: 'chat.completions', paradigms: ['sync'] }],
    });
    const offering = await createOffering(model.id, channelId, {
      fetch_profile: { mode: 'direct' },
      upstream_model_name: 'gpt-probe',
    });

    const res = await auth(
      request(app.getHttpServer()).post(`/admin/supply/offerings/${offering.id}/enable`),
    ).expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.offering_status).toBe('enabled');
    expect(res.body.violations).toEqual([]);
    expect(res.body.probe.status).toBe('completed');
    expect(res.body.probe.result.connectivity.ok).toBe(true);
    expect(res.body.probe.result.functional.ok).toBe(true);
    expect(res.body.probe.result.sample.text).toBe('ok');
    expect(upstreamHits).toBe(1); // exactly one real small sample

    const got = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings/${offering.id}`),
    ).expect(200);
    expect(got.body.status).toBe('enabled');
  });

  it('standalone probe completes without a status change; a re-probe inside the min interval is REJECTED (R5)', async () => {
    const { channelId } = await createProbeChain('gate-vendor-probe');
    const model = await createModel('gate-model-probe');
    const offering = await createOffering(model.id, channelId, {
      fetch_profile: { mode: 'direct' },
    });

    const first = await auth(
      request(app.getHttpServer()).post(`/admin/supply/offerings/${offering.id}/probe`),
    ).expect(200);
    expect(first.body.status).toBe('completed');
    expect(first.body.result.connectivity.ok).toBe(true);
    // Pure diagnosis: the offering did NOT move out of draft.
    const got = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings/${offering.id}`),
    ).expect(200);
    expect(got.body.status).toBe('draft');

    const second = await auth(
      request(app.getHttpServer()).post(`/admin/supply/offerings/${offering.id}/probe`),
    ).expect(200);
    expect(second.body.status).toBe('rejected');
    expect(second.body.rejection.reason).toBe('min_interval');
    expect(second.body.rejection.retry_after_seconds).toBeGreaterThan(0);
    expect(upstreamHits).toBe(1); // the rejected probe sent NO upstream byte
  });
});

describe('channel onboarding — 发现 → 批建 draft → 批探测 enable (批次5 slice2, §10)', () => {
  /**
   * A fake OpenAI-shaped upstream for the batch probe leg. Answers per the
   * requested model: `gpt-fail` → an EMPTY completion (functional fail →
   * offering stays `probing`), anything else → 'ok'.
   */
  let upstream: Server;
  let upstreamUrl: string;
  let savedEncryptionKey: string | undefined;

  beforeAll(async () => {
    savedEncryptionKey = process.env.SECRET_ENCRYPTION_KEY;
    process.env.SECRET_ENCRYPTION_KEY = SECRET_KEY_B64;
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { model?: string };
        const content = body.model === 'gpt-fail' ? '' : 'ok';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${String(addr.port)}/v1`;
  });

  afterAll(async () => {
    if (savedEncryptionKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = savedEncryptionKey;
    await new Promise<void>((resolve, reject) => {
      upstream.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  /** provider (REAL builtin openai dialect — code aspect, NO discovery endpoint) → channel → credential. */
  async function createOnboardingChain(
    slug: string,
    channelOverrides: Record<string, unknown> = {},
  ): Promise<{ providerId: string; channelId: string }> {
    const providerRes = await auth(request(app.getHttpServer()).post('/admin/supply/providers'))
      .send({ slug, name: `Brand ${slug}`, default_dialect: { ref: 'openai', version: '1.0.0' } })
      .expect(201);
    const providerId = providerRes.body.id as string;
    const channel = await createChannel(providerId, { base_url: upstreamUrl, ...channelOverrides });
    await auth(request(app.getHttpServer()).post('/admin/supply/credentials'))
      .send({
        channel_id: channel.id,
        name: 'onboard-key',
        secret: { scheme: 'bearer', api_key: BEARER_SECRET },
      })
      .expect(201);
    return { providerId, channelId: channel.id };
  }

  it('discover: a code-aspect dialect lists the official catalog by provider slug and flags existing offerings', async () => {
    const { channelId } = await createOnboardingChain('onboard-discover');
    await upsertModelSpec(db, {
      vendor: 'onboard-discover',
      modelId: 'gpt-cat-1',
      displayName: 'Cat One',
      type: 'text',
    });
    await upsertModelSpec(db, { vendor: 'onboard-discover', modelId: 'gpt-cat-2', type: 'text' });
    // Another vendor's spec must NOT leak into this channel's discovery.
    await upsertModelSpec(db, { vendor: 'other-vendor', modelId: 'foreign-model', type: 'text' });
    const model = await createModel('onboard-existing');
    await createOffering(model.id, channelId, { upstream_model_name: 'gpt-cat-1' });

    const res = await auth(
      request(app.getHttpServer()).post(`/admin/supply/channels/${channelId}/discover`),
    ).expect(200);
    expect(res.body.source).toBe('catalog');
    const models = res.body.models as {
      upstream_model_name: string;
      display_name?: string;
      exists_as_offering: boolean;
    }[];
    const names = models.map((m) => m.upstream_model_name).sort();
    expect(names).toEqual(['gpt-cat-1', 'gpt-cat-2']);
    const cat1 = models.find((m) => m.upstream_model_name === 'gpt-cat-1');
    expect(cat1?.display_name).toBe('Cat One');
    expect(cat1?.exists_as_offering).toBe(true);
    expect(models.find((m) => m.upstream_model_name === 'gpt-cat-2')?.exists_as_offering).toBe(
      false,
    );
  });

  it('discover: unknown channel → 404', async () => {
    await auth(
      request(app.getHttpServer()).post(`/admin/supply/channels/${NIL_UUID}/discover`),
    ).expect(404);
  });

  it('batch creates DRAFT offerings, mints sale cards from the official catalog with the route-group ratio folded in, and leaves unmatched models needs_pricing', async () => {
    const group = await createRouteGroup(db, { name: 'onboard-ratio', groupRatioBps: 15_000 });
    const { channelId } = await createOnboardingChain('onboard-batch', {
      route_group_id: group.id,
    });
    await createOfficialPrice(db, {
      provider: 'onboard-batch',
      modelSlug: 'gpt-batch-1',
      inputPricePer1m: 1_000_000n,
      outputPricePer1m: 2_000_000n,
    });

    const res = await auth(
      request(app.getHttpServer()).post(`/admin/supply/channels/${channelId}/offerings/batch`),
    )
      .send({
        items: [
          { upstream_model_name: 'gpt-batch-1', new_model: { name: 'ext-batch-1' } },
          { upstream_model_name: 'gpt-batch-nomatch', new_model: { name: 'ext-batch-2' } },
        ],
      })
      .expect(201);

    const created = res.body.offerings as {
      offering: { id: string; status: string; model_id: string; fetch_profile: { mode: string } };
      pricing: { status: string; price_card_id?: string; message?: string };
    }[];
    expect(created).toHaveLength(2);
    const [first, second] = created;
    if (first === undefined || second === undefined) throw new Error('expected 2 offerings');
    // 批建一律 draft — no probing, no enabled.
    expect(created.map((o) => o.offering.status)).toEqual(['draft', 'draft']);
    // Dialect-informed default: openai chat.completions → direct.
    expect(first.offering.fetch_profile.mode).toBe('direct');

    // Matched model: SALE card minted with the route group ratio folded in.
    expect(first.pricing.status).toBe('minted');
    const cardId = first.pricing.price_card_id ?? '';
    const card = await auth(
      request(app.getHttpServer()).get(`/admin/supply/price-cards/${cardId}`),
    ).expect(200);
    expect(card.body.method).toBe('model_token');
    expect(card.body.spec.inputPrice).toBe(1_000_000);
    expect(card.body.spec.outputPrice).toBe(2_000_000);
    expect(card.body.spec.groupRatioBps).toBe(15_000);
    const pricedModel = await auth(
      request(app.getHttpServer()).get(`/admin/supply/models/${first.offering.model_id}`),
    ).expect(200);
    expect(pricedModel.body.price_card_id).toBe(cardId);

    // Unmatched model: needs_pricing, NO card, never 0-priced (§10).
    expect(second.pricing.status).toBe('needs_pricing');
    expect(second.pricing.price_card_id).toBeUndefined();
    expect(res.body.needs_pricing_count).toBe(1);
    const unpricedModel = await auth(
      request(app.getHttpServer()).get(`/admin/supply/models/${second.offering.model_id}`),
    ).expect(200);
    expect(unpricedModel.body.price_card_id).toBeNull();
  });

  it('batch is all-or-nothing: a duplicate (model, channel) pick rolls the WHOLE batch back', async () => {
    const { channelId } = await createOnboardingChain('onboard-atomic');
    const model = await createModel('onboard-dup-model');
    await createOffering(model.id, channelId, { upstream_model_name: 'gpt-dup' });

    const res = await auth(
      request(app.getHttpServer()).post(`/admin/supply/channels/${channelId}/offerings/batch`),
    )
      .send({
        items: [
          { upstream_model_name: 'gpt-fresh', new_model: { name: 'onboard-fresh-model' } },
          { upstream_model_name: 'gpt-dup', model_id: model.id }, // (model, channel) taken
        ],
      })
      .expect(400);
    expect(res.body.error.message).toContain('rolled back');

    // The fresh item's offering and model were NOT created (transaction).
    const offerings = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings?channel_id=${channelId}`),
    ).expect(200);
    expect(offerings.body.data).toHaveLength(1);
    const models = await auth(request(app.getHttpServer()).get('/admin/supply/models')).expect(200);
    const names = (models.body.data as { name: string }[]).map((m) => m.name);
    expect(names).not.toContain('onboard-fresh-model');
  });

  it('batch item must carry exactly one of model_id / new_model', async () => {
    const { channelId } = await createOnboardingChain('onboard-shape');
    await auth(
      request(app.getHttpServer()).post(`/admin/supply/channels/${channelId}/offerings/batch`),
    )
      .send({ items: [{ upstream_model_name: 'gpt-x' }] })
      .expect(400);
  });

  it('probe-and-enable runs each draft offering through the FULL gate stack with per-offering verdicts', async () => {
    const { channelId } = await createOnboardingChain('onboard-enable');
    const card = await createPriceCard('onboard-sale-card');
    const priced = await createModel('onboard-priced', {
      price_card_id: card.id,
      operations: [{ operation: 'chat.completions', paradigms: ['sync'] }],
    });
    const unpriced = await createModel('onboard-unpriced');
    const okOffering = await createOffering(priced.id, channelId, {
      fetch_profile: { mode: 'direct' },
      upstream_model_name: 'gpt-ok',
    });
    const gatedOffering = await createOffering(unpriced.id, channelId, {
      fetch_profile: { mode: 'direct' },
      upstream_model_name: 'gpt-gated',
    });

    const res = await auth(
      request(app.getHttpServer()).post(
        `/admin/supply/channels/${channelId}/offerings/probe-and-enable`,
      ),
    )
      .send({})
      .expect(200);
    expect(res.body.enabled_count).toBe(1);
    const results = res.body.results as {
      offering_id: string;
      upstream_model_name: string;
      enabled: boolean;
      violations: { gate: string }[];
      probe?: { status: string };
    }[];
    expect(results).toHaveLength(2);

    const ok = results.find((r) => r.offering_id === okOffering.id);
    expect(ok?.enabled).toBe(true);
    expect(ok?.upstream_model_name).toBe('gpt-ok');
    expect(ok?.probe?.status).toBe('completed');
    const okRow = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings/${okOffering.id}`),
    ).expect(200);
    expect(okRow.body.status).toBe('enabled');

    // The un-priced offering fails the CONFIG gates first — no probe budget spent.
    const gated = results.find((r) => r.offering_id === gatedOffering.id);
    expect(gated?.enabled).toBe(false);
    expect(gated?.violations.map((v) => v.gate)).toContain('needs_pricing');
    expect(gated?.probe).toBeUndefined();
    const gatedRow = await auth(
      request(app.getHttpServer()).get(`/admin/supply/offerings/${gatedOffering.id}`),
    ).expect(200);
    expect(gatedRow.body.status).toBe('draft');
  });

  it('probe-and-enable: a failed probe leaves the offering probing, and an immediate retry is paced by the shared R5 budget (min interval)', async () => {
    const { channelId } = await createOnboardingChain('onboard-pace');
    const card = await createPriceCard('onboard-pace-card');
    const model = await createModel('onboard-pace-model', {
      price_card_id: card.id,
      operations: [{ operation: 'chat.completions', paradigms: ['sync'] }],
    });
    const offering = await createOffering(model.id, channelId, {
      fetch_profile: { mode: 'direct' },
      upstream_model_name: 'gpt-fail', // the fake upstream answers an EMPTY completion
    });

    const first = await auth(
      request(app.getHttpServer()).post(
        `/admin/supply/channels/${channelId}/offerings/probe-and-enable`,
      ),
    )
      .send({ offering_ids: [offering.id] })
      .expect(200);
    const r1 = first.body.results[0] as {
      enabled: boolean;
      offering_status: string;
      probe?: { status: string; result?: { functional: { ok: boolean } } };
    };
    expect(r1.enabled).toBe(false);
    expect(r1.offering_status).toBe('probing'); // honest: probed, not passed
    expect(r1.probe?.status).toBe('completed');
    expect(r1.probe?.result?.functional.ok).toBe(false);

    // Immediate retry: the SHARED lifecycle budget refuses the probe (R5 min
    // interval) — the batch endpoint adds no second budget and no bypass.
    const second = await auth(
      request(app.getHttpServer()).post(
        `/admin/supply/channels/${channelId}/offerings/probe-and-enable`,
      ),
    )
      .send({ offering_ids: [offering.id] })
      .expect(200);
    const r2 = second.body.results[0] as {
      enabled: boolean;
      offering_status: string;
      violations: { gate: string; message: string }[];
      probe?: { status: string };
    };
    expect(r2.enabled).toBe(false);
    expect(r2.probe?.status).toBe('rejected');
    expect(r2.violations[0]?.gate).toBe('golden_probe');
    expect(r2.violations[0]?.message).toContain('PROBE_MIN_INTERVAL_SEC');
  });

  it('probe-and-enable rejects an offering from ANOTHER channel (scope guard)', async () => {
    const { channelId } = await createOnboardingChain('onboard-scope-a');
    const other = await createOnboardingChain('onboard-scope-b');
    const model = await createModel('onboard-scope-model');
    const foreign = await createOffering(model.id, other.channelId, {
      upstream_model_name: 'gpt-foreign',
    });
    await auth(
      request(app.getHttpServer()).post(
        `/admin/supply/channels/${channelId}/offerings/probe-and-enable`,
      ),
    )
      .send({ offering_ids: [foreign.id] })
      .expect(400);
  });
});
