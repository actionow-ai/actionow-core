import { createUser, getAccountByTenant, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

const ADMIN_SECRET = 'e2e-auth-secret';

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

afterEach(async () => {
  await client`TRUNCATE TABLE api_key, account, "user", tenant RESTART IDENTITY CASCADE`;
});

function claimsOf(token: string): { sub: string; role: string } {
  return new JwtService({ secret: ADMIN_SECRET }).verify<{ sub: string; role: string }>(token);
}

describe('POST /auth/register', () => {
  it('200 + token, provisions a tenant + account, role=user, emailVerified=false', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'newuser@example.com', password: 'sup3rSecret' })
      .expect(200);

    expect(res.body.token).toBeTypeOf('string');
    const claims = claimsOf(res.body.token as string);
    expect(claims.role).toBe('user');

    // The user row exists with role=user, unverified email, and a tenant.
    const [user] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'newuser@example.com'));
    expect(user?.id).toBe(claims.sub);
    expect(user?.role).toBe('user');
    expect(user?.emailVerified).toBe(false);
    expect(user?.passwordHash).not.toBeNull();
    expect(user?.tenantId).toBeTypeOf('string');

    // A tenant + its billing account were provisioned for the user.
    const tenantId = user?.tenantId;
    if (tenantId === null || tenantId === undefined) throw new Error('user has no tenant');
    const account = await getAccountByTenant(db, tenantId);
    expect(account?.id).toBeTypeOf('string');
  });

  it('normalizes email to lowercase (case-insensitive registration)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'MixedCase@Example.com', password: 'sup3rSecret' })
      .expect(200);
    const claims = claimsOf(res.body.token as string);
    const user = await db.select().from(schema.user).where(eq(schema.user.id, claims.sub));
    expect(user[0]?.email).toBe('mixedcase@example.com');
  });

  it('400 invalid_input for a duplicate email', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'dup@example.com', password: 'sup3rSecret' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'dup@example.com', password: 'another' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('400 invalid_input for a malformed body', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'x@example.com' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});

describe('POST /auth/login', () => {
  it('200 + token for correct credentials; 401 for a wrong password', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'login@example.com', password: 'rightpass' })
      .expect(200);

    const ok = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'rightpass' })
      .expect(200);
    expect(ok.body.token).toBeTypeOf('string');
    expect(claimsOf(ok.body.token as string).role).toBe('user');

    const bad = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'wrong' })
      .expect(401);
    expect(bad.body.error.code).toBe('unauthorized');
  });

  it('401 unauthorized for an unknown email (no enumeration)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever' })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('migrated admin still works + RBAC gates admin endpoints', () => {
  it('admin (role=admin) logs in via /admin/auth/login and the JWT gates GET /admin/tenants', async () => {
    // Simulate a migrated admin_user row: a unified user with role=admin.
    await createUser(db, {
      email: 'admin@actionow.local',
      passwordHash: hashPassword('hunter2'),
      role: 'admin',
      emailVerified: true,
    });

    const adminRes = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin@actionow.local', password: 'hunter2' })
      .expect(200);
    const adminToken = adminRes.body.token as string;
    expect(claimsOf(adminToken).role).toBe('admin');

    // Admin token → 200 on the admin-gated route.
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('a regular user JWT does NOT pass the admin role gate (401)', async () => {
    const userRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'regular@example.com', password: 'sup3rSecret' })
      .expect(200);
    const userToken = userRes.body.token as string;
    expect(claimsOf(userToken).role).toBe('user');

    const res = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('authorization', `Bearer ${userToken}`)
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('the admin login rejects a regular user with 401 (no admin token for users)', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'regular2@example.com', password: 'sup3rSecret' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'regular2@example.com', password: 'sup3rSecret' })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});
