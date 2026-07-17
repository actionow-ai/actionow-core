import { createDb, type Database } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

/**
 * Readiness-probe e2e. Stands up a real Testcontainers Postgres + Redis and
 * leaves the real `BullmqJobQueue` (reads `env.REDIS_URL` → the test redis), so
 * all three `/readyz` checks (postgres SELECT 1, redis PING, BullMQ broker
 * reachable) run for REAL and report `ok`. Asserts:
 *   - `GET /health` → 200 `{status:'ok'}` (liveness; no dep checks, no auth)
 *   - `GET /readyz` → 200 `{status:'ready', checks:{...all ok}}` (no auth)
 */
const ADMIN_SECRET = 'readyz-e2e-secret';

let pg: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let client: ReturnType<typeof postgres>;
let db: Database;
let app: INestApplication;

beforeAll(async () => {
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const pgUri = pg.getConnectionUri();
  const redisUri = redis.getConnectionUrl();

  client = postgres(pgUri, { max: 5 });
  db = createDb(pgUri);
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const env: AppEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: pgUri,
    REDIS_URL: redisUri,
    API_PORT: 0,
    LOG_LEVEL: 'info',
    ALLOW_DEV_TENANT_HEADER: false,
    RATE_LIMIT_TENANT_PER_MIN: 600,
    RATE_LIMIT_RESOURCE_PER_MIN: 600,
    ADMIN_JWT_SECRET: ADMIN_SECRET,
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 10_000,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
    WORKER_HEALTH_PORT: 3001,
  };

  // Leave the real BullmqJobQueue + RATE_LIMITER wired (they read env.REDIS_URL →
  // the test redis), so the readiness checks exercise the real broker. Only
  // DB/ENV are overridden onto the Testcontainers handles.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DB)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await Promise.all([pg.stop(), redis.stop()]);
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

it('GET /health returns 200 ok with no dependency checks (liveness, no auth)', async () => {
  await request(server()).get('/health').expect(200, { status: 'ok' });
});

it('GET /readyz returns 200 with all dependency checks ok when deps are up (no auth)', async () => {
  const res = await request(server()).get('/readyz').expect(200);
  expect(res.body).toEqual({
    status: 'ready',
    checks: { postgres: 'ok', redis: 'ok' },
  });
});
