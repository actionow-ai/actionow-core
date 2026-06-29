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
});

afterEach(async () => {
  await resetDb(
    () => client`TRUNCATE TABLE api_key, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

/** Mint `n` api-keys for the seed tenant so the list exceeds a small page size. */
async function seedApiKeys(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await auth(request(app.getHttpServer()).post('/admin/api-keys')).send({ tenantId }).expect(201);
  }
}

interface Envelope {
  data: { id: string }[];
  next_cursor: string | null;
  has_more: boolean;
}

describe('uniform pagination envelope (GET /admin/api-keys)', () => {
  it('pages through all rows via cursor: first page has_more, last page does not, no overlap', async () => {
    await seedApiKeys(5);

    // First page of 2 → has_more true, a non-null next_cursor.
    const page1 = await auth(
      request(app.getHttpServer()).get('/admin/api-keys').query({ tenantId, limit: '2' }),
    ).expect(200);
    const env1 = page1.body as Envelope;
    expect(env1.data).toHaveLength(2);
    expect(env1.has_more).toBe(true);
    expect(env1.next_cursor).not.toBeNull();

    // Second page via the cursor → next 2 rows, no overlap with page 1.
    const page2 = await auth(
      request(app.getHttpServer())
        .get('/admin/api-keys')
        .query({ tenantId, limit: '2', cursor: env1.next_cursor }),
    ).expect(200);
    const env2 = page2.body as Envelope;
    expect(env2.data).toHaveLength(2);
    expect(env2.has_more).toBe(true);

    const page1Ids = env1.data.map((r) => r.id);
    const page2Ids = env2.data.map((r) => r.id);
    expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);

    // Final page → the 5th row, has_more false, next_cursor null.
    const page3 = await auth(
      request(app.getHttpServer())
        .get('/admin/api-keys')
        .query({ tenantId, limit: '2', cursor: env2.next_cursor }),
    ).expect(200);
    const env3 = page3.body as Envelope;
    expect(env3.data).toHaveLength(1);
    expect(env3.has_more).toBe(false);
    expect(env3.next_cursor).toBeNull();

    // Union of all three pages is exactly the 5 distinct keys (no gaps, no dupes).
    const all = [...page1Ids, ...page2Ids, ...env3.data.map((r) => r.id)];
    expect(new Set(all).size).toBe(5);
  });

  it('a malformed cursor is rejected as invalid_input (400)', async () => {
    await seedApiKeys(1);
    const res = await auth(
      request(app.getHttpServer())
        .get('/admin/api-keys')
        .query({ tenantId, cursor: 'not-a-valid-cursor!!!' }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('clamps an over-large limit and still returns the envelope shape', async () => {
    await seedApiKeys(3);
    const res = await auth(
      request(app.getHttpServer()).get('/admin/api-keys').query({ tenantId, limit: '9999' }),
    ).expect(200);
    const env = res.body as Envelope;
    expect(env.data).toHaveLength(3);
    expect(env.has_more).toBe(false);
    expect(env.next_cursor).toBeNull();
  });
});
