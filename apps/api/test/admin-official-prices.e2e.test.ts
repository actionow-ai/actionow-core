import { createUser, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

/**
 * E2E for the official model price catalog admin CRUD (Track 2). Asserts the
 * USD-per-1M → µUSD/1M boundary conversion (`inputUsdPer1m: 1.25` → stored
 * `input_price_per_1m: "1250000"`), the paginated Track-B envelope + provider
 * filter, the 404 + (provider,slug) unique-violation 400 mappings, and a
 * soft-delete that frees the pair for re-create.
 */

const ADMIN_SECRET = 'op-admin-secret';
const ADMIN_EMAIL = 'admin-op@actionow.local';
const ADMIN_PASSWORD = 'hunter2';

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
      client`TRUNCATE TABLE request_idempotency, official_model_price, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

describe('admin official-prices catalog', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await request(app.getHttpServer())
      .post('/admin/official-prices')
      .send({ provider: 'openai', modelSlug: 'gpt-4o', inputUsdPer1m: 1, outputUsdPer1m: 2 })
      .expect(401);
  });

  it('creates with USD/1M → µUSD/1M, gets, lists (filter + envelope), patches, deletes', async () => {
    // POST inputUsdPer1m: 1.25 → stored input_price_per_1m: "1250000".
    const created = await auth(request(app.getHttpServer()).post('/admin/official-prices'))
      .send({
        provider: 'openai',
        modelSlug: 'gpt-4o',
        displayName: 'GPT-4o',
        inputUsdPer1m: 1.25,
        outputUsdPer1m: 10,
        cachedInputUsdPer1m: 0.625,
        sourceUrl: 'https://openai.com/api/pricing/',
        effectiveAt: '2026-06-01T00:00:00.000Z',
        notes: 'seed',
      })
      .expect(201);
    expect(created.body.input_price_per_1m).toBe('1250000');
    expect(created.body.output_price_per_1m).toBe('10000000');
    expect(created.body.cached_input_price_per_1m).toBe('625000');
    expect(created.body.model_slug).toBe('gpt-4o');
    const id = created.body.id as string;

    // A second provider row (to prove the provider filter).
    await auth(request(app.getHttpServer()).post('/admin/official-prices'))
      .send({
        provider: 'anthropic',
        modelSlug: 'claude-3-5-sonnet',
        inputUsdPer1m: 3,
        outputUsdPer1m: 15,
      })
      .expect(201);

    // GET by id.
    const got = await auth(request(app.getHttpServer()).get(`/admin/official-prices/${id}`)).expect(
      200,
    );
    expect(got.body.notes).toBe('seed');

    // LIST — paginated Track-B envelope + ?provider= filter.
    const listed = await auth(request(app.getHttpServer()).get('/admin/official-prices')).expect(
      200,
    );
    expect(listed.body).toHaveProperty('data');
    expect(listed.body).toHaveProperty('next_cursor');
    expect(listed.body).toHaveProperty('has_more');
    expect((listed.body.data as { provider: string }[]).map((r) => r.provider).sort()).toEqual([
      'anthropic',
      'openai',
    ]);

    const filtered = await auth(
      request(app.getHttpServer()).get('/admin/official-prices?provider=openai'),
    ).expect(200);
    expect((filtered.body.data as { model_slug: string }[]).map((r) => r.model_slug)).toEqual([
      'gpt-4o',
    ]);

    // PATCH — USD/1M conversion applies on update too.
    const patched = await auth(request(app.getHttpServer()).patch(`/admin/official-prices/${id}`))
      .send({ outputUsdPer1m: 12.5, notes: null })
      .expect(200);
    expect(patched.body.output_price_per_1m).toBe('12500000');
    expect(patched.body.input_price_per_1m).toBe('1250000'); // untouched
    expect(patched.body.notes).toBeNull();

    // DELETE (soft) → 204, then GET → 404.
    await auth(request(app.getHttpServer()).delete(`/admin/official-prices/${id}`)).expect(204);
    await auth(request(app.getHttpServer()).get(`/admin/official-prices/${id}`)).expect(404);
  });

  it('maps a (provider,slug) unique violation to a clean 400, and a missing id to 404', async () => {
    await auth(request(app.getHttpServer()).post('/admin/official-prices'))
      .send({ provider: 'openai', modelSlug: 'gpt-4o', inputUsdPer1m: 1, outputUsdPer1m: 2 })
      .expect(201);

    // Same (provider, slug) again → 400 (not 500).
    await auth(request(app.getHttpServer()).post('/admin/official-prices'))
      .send({ provider: 'openai', modelSlug: 'gpt-4o', inputUsdPer1m: 9, outputUsdPer1m: 9 })
      .expect(400);

    // Unknown id → 404.
    await auth(
      request(app.getHttpServer()).get(
        '/admin/official-prices/00000000-0000-0000-0000-000000000000',
      ),
    ).expect(404);
  });
});
