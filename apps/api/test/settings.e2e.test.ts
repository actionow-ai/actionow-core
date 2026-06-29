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
 * E2E for the dynamic-config admin surface (动态配置): `/admin/settings` list /
 * override / reset, value validation, the env→DB overlay (source flips), and
 * admin-only authz. Each PUT/DELETE invalidates the resolver cache, so a
 * follow-up GET reflects the change immediately.
 */
const ADMIN_SECRET = 'op-admin-secret';
const ADMIN_EMAIL = 'admin-settings@actionow.local';
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
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      CREDIT_RATE: 10_000,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      RELAY_TRACE: 'off',
      RELAY_TRACE_MAX_BYTES: 1_000_000,
      STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
      ALLOW_DEV_TENANT_HEADER: false,
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
  await resetDb(() => client`TRUNCATE TABLE "user" RESTART IDENTITY CASCADE`);
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();
function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}
interface SettingView {
  key: string;
  value: unknown;
  source: 'env' | 'db';
}
async function getSetting(key: string): Promise<SettingView> {
  const res = await auth(request(server()).get('/admin/settings')).expect(200);
  const view = (res.body as SettingView[]).find((s) => s.key === key);
  if (view === undefined) throw new Error(`setting ${key} not in list`);
  return view;
}

describe('admin settings (动态配置)', () => {
  it('lists effective settings as env defaults when nothing is overridden', async () => {
    const res = await auth(request(server()).get('/admin/settings')).expect(200);
    const list = res.body as SettingView[];
    expect(list.length).toBeGreaterThanOrEqual(8);
    const relay = list.find((s) => s.key === 'RELAY_TRACE');
    expect(relay).toMatchObject({ value: 'off', source: 'env' });
  });

  it('overrides a setting (env→db), reflects it, then resets back to env', async () => {
    const put = await auth(request(server()).put('/admin/settings/RELAY_TRACE'))
      .send({ value: 'full' })
      .expect(200);
    expect(put.body).toMatchObject({ key: 'RELAY_TRACE', value: 'full', source: 'db' });
    // a follow-up GET reflects the override (cache was invalidated on write)
    expect(await getSetting('RELAY_TRACE')).toMatchObject({ value: 'full', source: 'db' });

    await auth(request(server()).delete('/admin/settings/RELAY_TRACE')).expect(200);
    expect(await getSetting('RELAY_TRACE')).toMatchObject({ value: 'off', source: 'env' });
  });

  it('coerces + stores a numeric setting', async () => {
    const put = await auth(request(server()).put('/admin/settings/STORAGE_MAX_UPLOAD_BYTES'))
      .send({ value: 4096 })
      .expect(200);
    expect(put.body).toMatchObject({ key: 'STORAGE_MAX_UPLOAD_BYTES', value: 4096, source: 'db' });
    await auth(request(server()).delete('/admin/settings/STORAGE_MAX_UPLOAD_BYTES')).expect(200);
  });

  it('rejects a value that fails the per-key schema (400)', async () => {
    await auth(request(server()).put('/admin/settings/RELAY_TRACE'))
      .send({ value: 'bogus' })
      .expect(400);
    await auth(request(server()).put('/admin/settings/STORAGE_MAX_UPLOAD_BYTES'))
      .send({ value: -5 })
      .expect(400);
  });

  it('rejects an unknown setting key (400)', async () => {
    await auth(request(server()).put('/admin/settings/DATABASE_URL'))
      .send({ value: 'x' })
      .expect(400);
  });

  it('rejects an unauthenticated request (401)', async () => {
    await request(server()).get('/admin/settings').expect(401);
  });
});
