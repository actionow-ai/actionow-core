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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

const ADMIN_SECRET = 'e2e-admin-secret';

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
  await client`TRUNCATE TABLE "user" RESTART IDENTITY CASCADE`;
});

describe('POST /admin/auth/login', () => {
  it('200 with a JWT carrying {sub, role} for valid credentials', async () => {
    const created = await createUser(db, {
      email: 'admin@actionow.local',
      passwordHash: hashPassword('hunter2'),
      role: 'admin',
      emailVerified: true,
    });

    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin@actionow.local', password: 'hunter2' })
      .expect(200);

    expect(res.body.token).toBeTypeOf('string');
    const claims = new JwtService({ secret: ADMIN_SECRET }).verify<{ sub: string; role: string }>(
      res.body.token as string,
    );
    expect(claims.sub).toBe(created.id);
    expect(claims.role).toBe('admin');
  });

  it('401 unauthorized for a wrong password', async () => {
    await createUser(db, {
      email: 'admin@actionow.local',
      passwordHash: hashPassword('hunter2'),
      role: 'admin',
      emailVerified: true,
    });

    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin@actionow.local', password: 'wrong' })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('401 unauthorized for an unknown email', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'nobody@actionow.local', password: 'hunter2' })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('400 invalid_input for a malformed body', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: 'admin@actionow.local' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});
