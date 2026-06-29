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

let jwt: string;

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
  jwt = login.body.token as string;
});

afterEach(async () => {
  await resetDb(
    () => client`TRUNCATE TABLE api_key, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

describe('one-step provision (POST /admin/provision) e2e', () => {
  it('atomically creates a tenant + account (opening credits) + usable api key', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/provision')
      .set('authorization', `Bearer ${jwt}`)
      .send({ name: 'Acme Inc', credits: 50, resourceAllowlist: [] })
      .expect(201);

    const body = res.body as {
      tenant: { id: string; name: string };
      account: { id: string; tenant_id: string; credit_balance: string };
      api_key: { id: string; plaintext: string };
    };
    expect(body.tenant.name).toBe('Acme Inc');
    expect(body.account.tenant_id).toBe(body.tenant.id);
    // 50 human credits → µcredits (1 credit = 1_000_000 µcredit).
    expect(body.account.credit_balance).toBe(String(50_000_000));
    expect(body.api_key.plaintext).toMatch(/^ak_[A-Za-z0-9_-]+$/);

    // The minted key is REAL and usable: it authenticates a data-plane call.
    await request(app.getHttpServer())
      .get('/v1/models')
      .set('authorization', `Bearer ${body.api_key.plaintext}`)
      .expect(200);
  });

  it('rejects a missing tenant name with 400 (and creates nothing)', async () => {
    await request(app.getHttpServer())
      .post('/admin/provision')
      .set('authorization', `Bearer ${jwt}`)
      .send({ credits: 10 })
      .expect(400);

    const tenants = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${jwt}`)
      .expect(200);
    expect((tenants.body.data as unknown[]).length).toBe(0);
  });
});
