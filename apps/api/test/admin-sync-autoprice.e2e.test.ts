import { AdapterRegistry, type ProviderAdapter } from '@actionow/adapters';
import type { ProviderModel } from '@actionow/contracts';
import { createUser, getModelByName, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV } from '../src/common/tokens.js';

/**
 * E2E for Track 2 `sync-models` AUTO-PRICING. A fake adapter
 * (`provider_type: 'fakeopenai'`, mapped via the channel's verbatim default to
 * the catalog provider) returns a model list: one slug MATCHES a seeded official
 * price, one does NOT, and one already exists with an operator price. We assert:
 * matched → priced + active + needs_pricing=false; unmatched → needs_pricing +
 * disabled + price 0 (never bill 0); existing → preserved. Finally the disabled
 * needs_pricing model is EXCLUDED from `GET /v1/models` (the never-bill-0 proof).
 */

const ADMIN_SECRET = 'autoprice-admin-secret';
const ADMIN_EMAIL = 'admin-autoprice@actionow.local';
const ADMIN_PASSWORD = 'hunter2';
const CHAT_RESOURCE = 'chat-autoprice';
const PROVIDER = 'fakeopenai';

/** The fake adapter's discovered catalog (matched / unmatched / pre-existing slugs). */
const FAKE_MODELS: ProviderModel[] = [
  { id: 'gpt-4o-2024-05-13', displayName: 'GPT-4o', capabilities: { vision: true } }, // matches official
  { id: 'gpt-mystery', displayName: 'Mystery' }, // no official → needs_pricing
  { id: 'gpt-preexisting', displayName: 'Pre-existing' }, // already a model → preserved
];

/** A minimal adapter that only does model discovery (the sync's only requirement). */
const fakeAdapter: ProviderAdapter = {
  providerType: PROVIDER,
  // eslint-disable-next-line @typescript-eslint/require-await
  async submit() {
    throw new Error('not used');
  },
  extractUsage() {
    return {};
  },
  mapError() {
    return { code: 'upstream_error' as const, message: 'not used', retryable: false };
  },
  // eslint-disable-next-line @typescript-eslint/require-await
  async listModels(): Promise<ProviderModel[]> {
    return FAKE_MODELS;
  },
};

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let token: string;
let tenantId: string;
let channelId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const registry = new AdapterRegistry();
  registry.register(fakeAdapter);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ADAPTERS)
    .useValue(registry)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
    })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();

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

  const t = await db.insert(schema.tenant).values({ name: 'autoprice-tenant' }).returning();
  const tenant = t[0];
  if (!tenant) throw new Error('no tenant');
  tenantId = tenant.id;

  // A chat resource + a fakeopenai channel (multi-model: no single-model override).
  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType: PROVIDER,
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [] },
  });
  const ch = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: CHAT_RESOURCE, providerType: PROVIDER, weight: 1, status: 'active' })
    .returning();
  if (!ch[0]) throw new Error('no channel');
  channelId = ch[0].id;
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

describe('sync-models auto-pricing (Track 2)', () => {
  it('prices a matched slug active, leaves unmatched needs_pricing+disabled, preserves a pre-existing model, and never bills 0', async () => {
    // Seed an official price for the matched (normalized) slug under the catalog provider.
    await auth(request(app.getHttpServer()).post('/admin/official-prices'))
      .send({ provider: PROVIDER, modelSlug: 'gpt-4o', inputUsdPer1m: 2.5, outputUsdPer1m: 10 })
      .expect(201);

    // A pre-existing model the operator already priced (must be preserved).
    await auth(request(app.getHttpServer()).post('/admin/models'))
      .send({
        name: 'gpt-preexisting',
        resourceId: CHAT_RESOURCE,
        inputPrice: 7,
        outputPrice: 7,
        status: 'active',
      })
      .expect(201);

    // Sync WITHOUT default prices → unmatched becomes needs_pricing (never bill 0).
    const res = await auth(
      request(app.getHttpServer()).post(
        `/admin/resources/${CHAT_RESOURCE}/channels/${channelId}/sync-models`,
      ),
    )
      .send({})
      .expect(200);

    // The per-model summary reflects the three outcomes.
    expect(res.body.summary).toContainEqual({ name: 'gpt-4o-2024-05-13', priced: 'official' });
    expect(res.body.summary).toContainEqual({ name: 'gpt-mystery', priced: 'needs_pricing' });
    expect(res.body.summary).toContainEqual({ name: 'gpt-preexisting', priced: 'existing' });

    // matched → official µUSD/1M (2.5/10 USD → 2_500_000/10_000_000), active.
    const matched = await getModelByName(db, 'gpt-4o-2024-05-13');
    expect(matched?.inputPrice).toBe(2_500_000n);
    expect(matched?.outputPrice).toBe(10_000_000n);
    expect(matched?.status).toBe('active');
    expect(matched?.needsPricing).toBe(false);

    // unmatched → disabled + needs_pricing + prices 0 (NEVER active-with-0).
    const unmatched = await getModelByName(db, 'gpt-mystery');
    expect(unmatched?.inputPrice).toBe(0n);
    expect(unmatched?.outputPrice).toBe(0n);
    expect(unmatched?.status).toBe('disabled');
    expect(unmatched?.needsPricing).toBe(true);

    // pre-existing → operator price preserved.
    const preexisting = await getModelByName(db, 'gpt-preexisting');
    expect(preexisting?.inputPrice).toBe(7n);
    expect(preexisting?.status).toBe('active');

    // ── never-bill-0 proof: the disabled/needs_pricing model is EXCLUDED from /v1/models.
    const account = await db
      .insert(schema.account)
      .values({ tenantId, creditBalance: 1_000_000n })
      .returning();
    if (!account[0]) throw new Error('no account');
    const keyRes = await auth(request(app.getHttpServer()).post('/admin/api-keys'))
      .send({ tenantId })
      .expect(201);
    const plaintext = keyRes.body.plaintext as string;

    const models = await request(app.getHttpServer())
      .get('/v1/models')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(200);
    const ids = (models.body.data as { id: string }[]).map((m) => m.id);
    expect(ids).toContain('gpt-4o-2024-05-13'); // active priced model visible
    expect(ids).not.toContain('gpt-mystery'); // disabled needs_pricing model hidden
  });
});
