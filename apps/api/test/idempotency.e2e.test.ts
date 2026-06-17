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

const ADMIN_SECRET = 'e2e-admin-secret';
const ADMIN_EMAIL = 'admin@actionow.local';
const ADMIN_PASSWORD = 'hunter2';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

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
      DEV_TENANT_ID: undefined,
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

let token: string;

beforeEach(async () => {
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  token = res.body.token as string;
});

afterEach(async () => {
  await client`TRUNCATE TABLE request_idempotency, api_key, tenant, "user" RESTART IDENTITY CASCADE`;
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

/** Count of rows in `request_idempotency` for a given scope (the security probe). */
async function idemRowsForScope(scope: string): Promise<number> {
  const rows =
    await client`SELECT COUNT(*)::int AS n FROM request_idempotency WHERE scope = ${scope}`;
  return rows[0]?.n as number;
}

describe('Track D5: Idempotency-Key replay (allowlisted admin POSTs)', () => {
  it('double-POST /admin/tenants with the SAME key replays the first response + creates ONE row', async () => {
    const key = 'idem-tenant-1';

    const first = await auth(
      request(app.getHttpServer()).post('/admin/tenants').set('Idempotency-Key', key),
    )
      .send({ name: 'acme' })
      .expect(201);

    const second = await auth(
      request(app.getHttpServer()).post('/admin/tenants').set('Idempotency-Key', key),
    )
      .send({ name: 'acme' })
      .expect(201);

    // Identical body (same id) — the second POST replayed, not re-created.
    expect(second.body).toEqual(first.body);
    expect(second.body.id).toBe(first.body.id);

    // Exactly ONE tenant row exists.
    const tenants = await client`SELECT id FROM tenant`;
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.id).toBe(first.body.id);

    // One cached replay row for this route's scope.
    expect(await idemRowsForScope('POST /admin/tenants')).toBe(1);
  });

  it('the SAME key on a DIFFERENT route (scope) is NOT conflated', async () => {
    const key = 'shared-key';

    // First a tenant on POST /admin/tenants.
    const tenant = await auth(
      request(app.getHttpServer()).post('/admin/tenants').set('Idempotency-Key', key),
    )
      .send({ name: 'acme' })
      .expect(201);

    // The SAME key against POST /admin/models must NOT replay the tenant body —
    // it runs the models handler fresh (different scope).
    await auth(request(app.getHttpServer()).post('/admin/resources').set('Idempotency-Key', key))
      .send({
        id: 'res-x',
        tenantId: tenant.body.id,
        kind: 'model',
        modality: 'text',
        providerType: 'openai',
        execModes: ['blocking'],
        ioSchema: { inputs: [], outputs: [] },
      })
      .expect(201);

    const model = await auth(
      request(app.getHttpServer()).post('/admin/models').set('Idempotency-Key', key),
    )
      .send({ name: 'gpt-x', resourceId: 'res-x' })
      .expect(201);

    // The model response is its own (a model, not the tenant replay).
    expect(model.body.name).toBe('gpt-x');
    expect(model.body.id).not.toBe(tenant.body.id);

    // Each route has its own independent cached row under the same key.
    expect(await idemRowsForScope('POST /admin/tenants')).toBe(1);
    expect(await idemRowsForScope('POST /admin/models')).toBe(1);
  });

  it('WITHOUT an Idempotency-Key header → normal behavior (two POSTs → two entities)', async () => {
    const a = await auth(request(app.getHttpServer()).post('/admin/tenants'))
      .send({ name: 'acme' })
      .expect(201);
    const b = await auth(request(app.getHttpServer()).post('/admin/tenants'))
      .send({ name: 'acme' })
      .expect(201);

    expect(b.body.id).not.toBe(a.body.id);

    const tenants = await client`SELECT id FROM tenant`;
    expect(tenants).toHaveLength(2);

    // Nothing was cached (the header was absent → interceptor no-op).
    expect(await idemRowsForScope('POST /admin/tenants')).toBe(0);
  });

  describe('SECURITY: secret-returning endpoints IGNORE the header (never cache the plaintext)', () => {
    it('POST /admin/api-keys with an Idempotency-Key mints TWO distinct keys AND caches NOTHING', async () => {
      // A tenant to mint keys against.
      const tenant = await auth(request(app.getHttpServer()).post('/admin/tenants'))
        .send({ name: 'acme' })
        .expect(201);

      const key = 'idem-apikey-1';

      const first = await auth(
        request(app.getHttpServer()).post('/admin/api-keys').set('Idempotency-Key', key),
      )
        .send({ tenantId: tenant.body.id })
        .expect(201);

      const second = await auth(
        request(app.getHttpServer()).post('/admin/api-keys').set('Idempotency-Key', key),
      )
        .send({ tenantId: tenant.body.id })
        .expect(201);

      // The header is IGNORED: two distinct keys are minted (NOT a replay), and
      // the one-time plaintexts differ.
      expect(second.body.id).not.toBe(first.body.id);
      expect(second.body.plaintext).not.toBe(first.body.plaintext);
      expect(typeof first.body.plaintext).toBe('string');
      expect(first.body.plaintext.length).toBeGreaterThan(0);

      // THE SECURITY ASSERTION: no row for the api-keys scope was ever written,
      // so the api-key plaintext was never cached at rest.
      expect(await idemRowsForScope('POST /admin/api-keys')).toBe(0);

      // Belt-and-suspenders: no plaintext appears anywhere in the table.
      const allBodies = await client`SELECT response_body FROM request_idempotency`;
      for (const row of allBodies) {
        const serialized = JSON.stringify(row.response_body);
        expect(serialized).not.toContain(first.body.plaintext);
        expect(serialized).not.toContain(second.body.plaintext);
      }
    });
  });
});
