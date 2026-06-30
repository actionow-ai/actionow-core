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
 * E2E for the model spec catalog admin CRUD (规格库). Asserts create → get → list
 * (paginated Track-B envelope + vendor/type filters) → patch (incl. re-key) →
 * soft-delete (404 after, frees the pair), plus the (vendor,model_id)
 * unique-violation 400 and unknown-id 404 mappings. `model_spec` carries no
 * prices, so there's no money-conversion boundary to check (that's official-prices).
 */

const ADMIN_SECRET = 'ms-admin-secret';
const ADMIN_EMAIL = 'admin-ms@actionow.local';
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
      client`TRUNCATE TABLE request_idempotency, audit_log, model_spec, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

describe('admin model-specs catalog (规格库)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await request(app.getHttpServer())
      .post('/admin/model-specs')
      .send({ vendor: 'openai', modelId: 'gpt-5.5', type: 'text' })
      .expect(401);
  });

  it('creates, gets, lists (vendor/type filters + envelope), patches, deletes', async () => {
    const created = await auth(request(app.getHttpServer()).post('/admin/model-specs'))
      .send({
        vendor: 'openai',
        modelId: 'gpt-5.5',
        type: 'text',
        displayName: 'GPT-5.5',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        keyParams: ['reasoning_effort', 'temperature'],
        contextWindow: '400k',
        confidence: 'firstparty',
        billingEligible: true,
        intro: 'Frontier reasoning model.',
        sourceUrl: 'https://openai.com/api/pricing/',
        asOf: '2026-06',
      })
      .expect(201);
    expect(created.body.vendor).toBe('openai');
    expect(created.body.model_id).toBe('gpt-5.5');
    expect(created.body.type).toBe('text');
    expect(created.body.input_modalities).toEqual(['text', 'image']);
    expect(created.body.confidence).toBe('firstparty');
    expect(created.body.billing_eligible).toBe(true);
    const id = created.body.id as string;

    // A second vendor + type (to prove the filters).
    await auth(request(app.getHttpServer()).post('/admin/model-specs'))
      .send({ vendor: 'kling', modelId: 'kling-v2', type: 'video', confidence: 'reconstructed' })
      .expect(201);

    // GET by id.
    const got = await auth(request(app.getHttpServer()).get(`/admin/model-specs/${id}`)).expect(
      200,
    );
    expect(got.body.intro).toBe('Frontier reasoning model.');

    // LIST — paginated Track-B envelope.
    const listed = await auth(request(app.getHttpServer()).get('/admin/model-specs')).expect(200);
    expect(listed.body).toHaveProperty('data');
    expect(listed.body).toHaveProperty('next_cursor');
    expect(listed.body).toHaveProperty('has_more');
    expect((listed.body.data as { vendor: string }[]).map((r) => r.vendor).sort()).toEqual([
      'kling',
      'openai',
    ]);

    // ?vendor= filter.
    const byVendor = await auth(
      request(app.getHttpServer()).get('/admin/model-specs?vendor=openai'),
    ).expect(200);
    expect((byVendor.body.data as { model_id: string }[]).map((r) => r.model_id)).toEqual([
      'gpt-5.5',
    ]);

    // ?type= filter.
    const byType = await auth(
      request(app.getHttpServer()).get('/admin/model-specs?type=video'),
    ).expect(200);
    expect((byType.body.data as { vendor: string }[]).map((r) => r.vendor)).toEqual(['kling']);

    // PATCH — clear a nullable, flip a flag.
    const patched = await auth(request(app.getHttpServer()).patch(`/admin/model-specs/${id}`))
      .send({ status: 'GA', billingEligible: false, intro: null })
      .expect(200);
    expect(patched.body.status).toBe('GA');
    expect(patched.body.billing_eligible).toBe(false);
    expect(patched.body.intro).toBeNull();
    expect(patched.body.model_id).toBe('gpt-5.5'); // untouched

    // DELETE (soft) → 204, then GET → 404.
    await auth(request(app.getHttpServer()).delete(`/admin/model-specs/${id}`)).expect(204);
    await auth(request(app.getHttpServer()).get(`/admin/model-specs/${id}`)).expect(404);
  });

  it('maps a (vendor,model_id) unique violation to a clean 400, and a missing id to 404', async () => {
    await auth(request(app.getHttpServer()).post('/admin/model-specs'))
      .send({ vendor: 'openai', modelId: 'gpt-5.5', type: 'text' })
      .expect(201);

    // Same (vendor, model_id) again → 400 (not 500).
    await auth(request(app.getHttpServer()).post('/admin/model-specs'))
      .send({ vendor: 'openai', modelId: 'gpt-5.5', type: 'image' })
      .expect(400);

    // Unknown id → 404.
    await auth(
      request(app.getHttpServer()).get('/admin/model-specs/00000000-0000-0000-0000-000000000000'),
    ).expect(404);
  });
});
