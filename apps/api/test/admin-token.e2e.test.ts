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
    () => client`TRUNCATE TABLE admin_token, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

async function mint(body: {
  name: string;
  expiresAt?: string;
}): Promise<{ id: string; plaintext: string }> {
  const res = await request(app.getHttpServer())
    .post('/admin/tokens')
    .set('authorization', `Bearer ${jwt}`)
    .send(body)
    .expect(201);
  return { id: res.body.id as string, plaintext: res.body.plaintext as string };
}

describe('admin service tokens (M2M) e2e', () => {
  it('mints an at_ token returning the plaintext once', async () => {
    const { id, plaintext } = await mint({ name: 'ci-bot' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plaintext).toMatch(/^at_[A-Za-z0-9_-]+$/);
  });

  it('authenticates a protected admin route with the service token (no human JWT)', async () => {
    const { plaintext } = await mint({ name: 'svc' });
    // The service token alone authorizes an admin call — no JWT involved.
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(200);
  });

  it('lists tokens without exposing the hash or plaintext', async () => {
    const { id } = await mint({ name: 'listed' });
    const res = await request(app.getHttpServer())
      .get('/admin/tokens')
      .set('authorization', `Bearer ${jwt}`)
      .expect(200);
    const row = (res.body.data as Record<string, unknown>[]).find((r) => r.id === id);
    expect(row).toMatchObject({ id, name: 'listed', status: 'active' });
    expect(row).not.toHaveProperty('hash');
    expect(row).not.toHaveProperty('plaintext');
  });

  it('revokes a token (204) → the token is rejected with 401 afterward', async () => {
    const { id, plaintext } = await mint({ name: 'revoke-me' });
    // Works before revoke.
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/admin/tokens/${id}`)
      .set('authorization', `Bearer ${jwt}`)
      .expect(204);

    // Rejected after revoke.
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(401);
  });

  it('rejects an expired service token with 401', async () => {
    const { plaintext } = await mint({ name: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' });
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(401);
  });

  it('rejects revoking an unknown token id with 404', async () => {
    await request(app.getHttpServer())
      .delete('/admin/tokens/00000000-0000-0000-0000-000000000000')
      .set('authorization', `Bearer ${jwt}`)
      .expect(404);
  });
});
