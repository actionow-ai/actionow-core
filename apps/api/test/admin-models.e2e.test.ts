import { createUser, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
let tenantId: string;

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

  const t = await request(app.getHttpServer())
    .post('/admin/tenants')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'acme' })
    .expect(201);
  tenantId = t.body.id as string;

  // A chat resource for the model to route to.
  await request(app.getHttpServer())
    .post('/admin/resources')
    .set('authorization', `Bearer ${token}`)
    .send({
      id: 'gpt4o-res',
      tenantId,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
    })
    .expect(201);
});

afterEach(async () => {
  await client`TRUNCATE TABLE request_idempotency, model_grant, model, api_key, ledger_txn, pricebook_entry, upstream_channel, resource_version, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

/** Sign a non-admin (`role: 'user'`) JWT with the same secret as a real login. */
function userToken(): string {
  return new JwtService().sign(
    { sub: '00000000-0000-0000-0000-000000000001', role: 'user' },
    { secret: ADMIN_SECRET, expiresIn: '12h' },
  );
}

describe('admin model catalog', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await request(app.getHttpServer())
      .post('/admin/models')
      .send({ name: 'gpt-4o', resourceId: 'gpt4o-res' })
      .expect(401);
  });

  it('rejects a non-admin (user) JWT', async () => {
    await request(app.getHttpServer())
      .post('/admin/models')
      .set('authorization', `Bearer ${userToken()}`)
      .send({ name: 'gpt-4o', resourceId: 'gpt4o-res' })
      .expect((res) => {
        expect([401, 403]).toContain(res.status);
      });
  });

  it('creates a model, lists it, and prices serialize as strings', async () => {
    const created = await auth(
      request(app.getHttpServer())
        .post('/admin/models')
        .send({
          name: 'gpt-4o',
          resourceId: 'gpt4o-res',
          display: 'GPT-4o',
          inputPrice: 30,
          outputPrice: 60,
          capabilities: { tools: true },
        }),
    ).expect(201);
    expect(created.body.name).toBe('gpt-4o');
    expect(created.body.input_price).toBe('30');
    expect(created.body.output_price).toBe('60');
    expect(created.body.visibility).toBe('public');

    const list = await auth(request(app.getHttpServer()).get('/admin/models')).expect(200);
    expect(list.body.data.map((m: { name: string }) => m.name)).toContain('gpt-4o');
  });

  it('grants a tenant-visibility model to a tenant', async () => {
    await auth(
      request(app.getHttpServer())
        .post('/admin/models')
        .send({ name: 'claude-x', resourceId: 'gpt4o-res', visibility: 'tenant' }),
    ).expect(201);

    await auth(
      request(app.getHttpServer()).post('/admin/models/claude-x/grants').send({ tenantId }),
    ).expect(201);
  });
});

describe('D2: model get / patch / delete', () => {
  it('creates → GET-by-name → PATCH (fields change) → DELETE (204) → 404 + delisted', async () => {
    await auth(
      request(app.getHttpServer())
        .post('/admin/models')
        .send({ name: 'gpt-d2', resourceId: 'gpt4o-res', inputPrice: 3, outputPrice: 7 }),
    ).expect(201);

    // GET-by-name
    const got = await auth(request(app.getHttpServer()).get('/admin/models/gpt-d2')).expect(200);
    expect(got.body.name).toBe('gpt-d2');
    expect(got.body.input_price).toBe('3');
    expect(got.body.visibility).toBe('public');

    // PATCH — display/prices (µcredit ints stay ints)/visibility/status all change.
    const patched = await auth(
      request(app.getHttpServer()).patch('/admin/models/gpt-d2').send({
        display: 'GPT D2',
        inputPrice: 30,
        visibility: 'tenant',
        status: 'disabled',
      }),
    ).expect(200);
    expect(patched.body.display).toBe('GPT D2');
    expect(patched.body.input_price).toBe('30');
    expect(patched.body.output_price).toBe('7'); // untouched
    expect(patched.body.visibility).toBe('tenant');
    expect(patched.body.status).toBe('disabled');

    // DELETE → 204
    await auth(request(app.getHttpServer()).delete('/admin/models/gpt-d2')).expect(204);

    // GET-by-name now 404 AND the catalog list excludes it.
    await auth(request(app.getHttpServer()).get('/admin/models/gpt-d2')).expect(404);
    const list = await auth(request(app.getHttpServer()).get('/admin/models')).expect(200);
    expect(list.body.data.map((m: { name: string }) => m.name)).not.toContain('gpt-d2');

    // second delete is a 404 (idempotent soft-delete).
    await auth(request(app.getHttpServer()).delete('/admin/models/gpt-d2')).expect(404);
  });

  it('GET/PATCH/DELETE an unknown model → 404', async () => {
    await auth(request(app.getHttpServer()).get('/admin/models/nope')).expect(404);
    await auth(
      request(app.getHttpServer()).patch('/admin/models/nope').send({ status: 'active' }),
    ).expect(404);
    await auth(request(app.getHttpServer()).delete('/admin/models/nope')).expect(404);
  });
});

describe('re-create after soft-delete / conflict', () => {
  it('re-creates a soft-deleted model name cleanly (201) and GET works on the new row', async () => {
    // Create → soft-delete (204).
    const first = await auth(
      request(app.getHttpServer())
        .post('/admin/models')
        .send({ name: 'reuse-me', resourceId: 'gpt4o-res', inputPrice: 5 }),
    ).expect(201);
    await auth(request(app.getHttpServer()).delete('/admin/models/reuse-me')).expect(204);
    await auth(request(app.getHttpServer()).get('/admin/models/reuse-me')).expect(404);

    // POST the SAME name again → 201 (the partial unique index frees the name),
    // and the new row is a DISTINCT id.
    const second = await auth(
      request(app.getHttpServer())
        .post('/admin/models')
        .send({ name: 'reuse-me', resourceId: 'gpt4o-res', inputPrice: 9 }),
    ).expect(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.input_price).toBe('9');

    // GET-by-name resolves to the new live row.
    const got = await auth(request(app.getHttpServer()).get('/admin/models/reuse-me')).expect(200);
    expect(got.body.id).toBe(second.body.id);
    expect(got.body.input_price).toBe('9');
  });

  it('re-creating an existing resource id is a clean 400 (not a 500)', async () => {
    const body = {
      id: 'dup-res',
      tenantId,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
    };
    await auth(request(app.getHttpServer()).post('/admin/resources').send(body)).expect(201);

    // Re-POSTing the same id collides on the resource_version PK → 23505, mapped
    // to a clean invalid_input 400 instead of a Postgres 500.
    const conflict = await auth(
      request(app.getHttpServer()).post('/admin/resources').send(body),
    ).expect(400);
    expect(conflict.body.error.code).toBe('invalid_input');
    expect(conflict.body.error.message).toContain('dup-res');
  });
});

describe('D2: model_grant list / revoke', () => {
  it('grant → list shows it → revoke (204) → list empty', async () => {
    await auth(
      request(app.getHttpServer())
        .post('/admin/models')
        .send({ name: 'grant-m', resourceId: 'gpt4o-res', visibility: 'tenant' }),
    ).expect(201);
    await auth(
      request(app.getHttpServer()).post('/admin/models/grant-m/grants').send({ tenantId }),
    ).expect(201);

    const before = await auth(
      request(app.getHttpServer()).get('/admin/models/grant-m/grants'),
    ).expect(200);
    expect(before.body.data.map((g: { tenant_id: string }) => g.tenant_id)).toContain(tenantId);

    // revoke = HARD delete (model_grant has no deleted_at) → 204.
    await auth(
      request(app.getHttpServer()).delete(`/admin/models/grant-m/grants/${tenantId}`),
    ).expect(204);

    const after = await auth(
      request(app.getHttpServer()).get('/admin/models/grant-m/grants'),
    ).expect(200);
    expect(after.body.data).toHaveLength(0);

    // a second revoke is a 404 (no such grant).
    await auth(
      request(app.getHttpServer()).delete(`/admin/models/grant-m/grants/${tenantId}`),
    ).expect(404);
  });

  it('lists grants of an unknown model → 404', async () => {
    await auth(request(app.getHttpServer()).get('/admin/models/nope/grants')).expect(404);
  });
});
