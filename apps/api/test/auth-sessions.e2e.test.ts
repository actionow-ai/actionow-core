import { createTenant, schema } from '@actionow/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const ADMIN_SECRET = 'e2e-sessions-secret';

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
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      // No JWT_* keys → effective HS256 / 12h / legacy-on (the unchanged default).
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

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE session, api_key, subject, account, "user", tenant RESTART IDENTITY CASCADE`,
  );
});

describe('POST /auth/login → additive token pair', () => {
  it('returns {token, accessToken, refreshToken, expiresIn} with token === accessToken', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'pair@example.com', password: 'sup3rSecret' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'pair@example.com', password: 'sup3rSecret' })
      .expect(200);

    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.accessToken).toBe(res.body.token);
    expect(res.body.refreshToken).toMatch(/^rt_/);
    expect(res.body.expiresIn).toBe('12h');

    // The access token gates the console (a registered user has a tenant + account).
    await request(app.getHttpServer())
      .get('/console/me')
      .set('authorization', `Bearer ${res.body.accessToken as string}`)
      .expect(200);
  });
});

describe('POST /auth/refresh → rotation + reuse detection', () => {
  it('rotates the pair; the old refresh is then 401', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'rot@example.com', password: 'sup3rSecret' })
      .expect(200);
    const firstRefresh = reg.body.refreshToken as string;

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(200);
    expect(rotated.body.accessToken).toBeTypeOf('string');
    expect(rotated.body.refreshToken).not.toBe(firstRefresh);

    // The rotated access token still gates the console.
    await request(app.getHttpServer())
      .get('/console/me')
      .set('authorization', `Bearer ${rotated.body.accessToken as string}`)
      .expect(200);

    // The OLD refresh is now revoked → 401.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefresh })
      .expect(401);
  });

  it('reuse of a rotated refresh revokes the whole family (theft response)', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'theft@example.com', password: 'sup3rSecret' })
      .expect(200);
    const r1 = reg.body.refreshToken as string;

    // Rotate once → r2 is the live token of the family.
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: r1 })
      .expect(200);
    const r2 = rotated.body.refreshToken as string;

    // Replay the OLD (revoked) r1 → 401 AND it revokes the family.
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: r1 }).expect(401);

    // The previously-live r2 is now ALSO dead (family revoked).
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: r2 }).expect(401);
  });

  it('logout revokes the refresh token (then 401 on refresh)', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'logout@example.com', password: 'sup3rSecret' })
      .expect(200);
    const refresh = reg.body.refreshToken as string;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: refresh })
      .expect(204);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(401);
  });

  it('400 invalid_input for a missing refreshToken', async () => {
    const res = await request(app.getHttpServer()).post('/auth/refresh').send({}).expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});

describe('member refresh re-mints typ:subject + tenant_id', () => {
  it('a member refresh yields a token that still gates /member and carries the tenant', async () => {
    const tenant = await createTenant(db, { name: 'member-refresh-tenant' });

    const reg = await request(app.getHttpServer())
      .post('/auth/register-member')
      .send({ email: 'm@example.com', password: 'sup3rSecret', tenantId: tenant.id })
      .expect(200);
    const refresh = reg.body.refreshToken as string;

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);

    // The re-minted member access token gates the member plane (typ:'subject' + tenant).
    await request(app.getHttpServer())
      .get('/member/me')
      .set('authorization', `Bearer ${rotated.body.accessToken as string}`)
      .expect(200);

    // ...and is rejected by the OPERATOR console (typ:'subject' is not an operator token).
    await request(app.getHttpServer())
      .get('/console/me')
      .set('authorization', `Bearer ${rotated.body.accessToken as string}`)
      .expect(401);
  });
});

/** base64url-decode a JWT payload and read its `role` claim. */
function decodeRole(accessToken: string): string {
  const payload = accessToken.split('.')[1] ?? '';
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: string };
  return json.role ?? '';
}

describe('POST /auth/login (unified) → refresh preserves the platform-admin role', () => {
  it('a platform admin login → refresh keeps role:admin (no silent downgrade) + still gates /admin', async () => {
    const { hashPassword } = await import('@actionow/infra');
    const { createUser } = await import('@actionow/db');
    // A platform admin: a `user` row with role='admin'.
    await createUser(db, {
      email: 'admin@actionow.local',
      passwordHash: hashPassword('actionow-dev-password'),
      role: 'admin',
      emailVerified: true,
    });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@actionow.local', password: 'actionow-dev-password' })
      .expect(200);
    // The login access token is correct: role:'admin'.
    expect(decodeRole(login.body.accessToken as string)).toBe('admin');

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken as string })
      .expect(200);
    // The bug: the refreshed access token used to decode to role:'user'.
    expect(decodeRole(rotated.body.accessToken as string)).toBe('admin');

    // ...and the refreshed token STILL gates the /admin plane.
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${rotated.body.accessToken as string}`)
      .expect(200);
  });

  it('a tenant operator login → refresh stays role:user (regression guard)', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'operator@example.com', password: 'sup3rSecret' })
      .expect(200);
    expect(decodeRole(reg.body.accessToken as string)).toBe('user');

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: reg.body.refreshToken as string })
      .expect(200);
    expect(decodeRole(rotated.body.accessToken as string)).toBe('user');
  });

  it('a tenant-less platform admin is forbidden (403), not unauthorized, on the tenant console', async () => {
    const { hashPassword } = await import('@actionow/infra');
    const { createUser } = await import('@actionow/db');
    await createUser(db, {
      email: 'admin-console@actionow.local',
      passwordHash: hashPassword('actionow-dev-password'),
      role: 'admin',
      emailVerified: true,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin-console@actionow.local', password: 'actionow-dev-password' })
      .expect(200);

    // Valid credential, but no tenant → plane mismatch → 403 (not a 401 that would
    // lure the client into a refresh/re-login loop).
    const res = await request(app.getHttpServer())
      .get('/console/me')
      .set('authorization', `Bearer ${login.body.accessToken as string}`)
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('admin refresh re-mints the admin role', () => {
  it('an admin login → refresh keeps gating /admin', async () => {
    const { hashPassword } = await import('@actionow/infra');
    const { createUser } = await import('@actionow/db');
    await createUser(db, {
      email: 'admin-sess@actionow.local',
      passwordHash: hashPassword('hunter2'),
      role: 'admin',
      emailVerified: true,
    });

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin-sess@actionow.local', password: 'hunter2' })
      .expect(200);
    expect(login.body.refreshToken).toMatch(/^rt_/);

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken as string })
      .expect(200);

    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${rotated.body.accessToken as string}`)
      .expect(200);
  });
});
