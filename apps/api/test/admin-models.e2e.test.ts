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
  await client`TRUNCATE TABLE model_grant, model, api_key, ledger_txn, pricebook_entry, upstream_channel, resource_version, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
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
    expect(list.body.map((m: { name: string }) => m.name)).toContain('gpt-4o');
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
