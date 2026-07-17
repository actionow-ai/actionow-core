import { createUser, schema, upsertBreaker } from '@actionow/db';
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
let channelId: string;

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

  // 批次6 D3: the resource/channel admin endpoints (and the schema
  // definitions) are deleted, but the DB still carries both tables AND the
  // `channel_breaker.channel_id` FK until D4's DROP migration — so the
  // fixture seeds them with RAW SQL. D4 removes this seeding with the FK.
  const t = await request(app.getHttpServer())
    .post('/admin/tenants')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'brk' })
    .expect(201);
  const tenantId = t.body.id as string;
  await client`
    INSERT INTO resource (id, tenant_id, kind, modality, provider_type, exec_modes, current_version)
    VALUES ('brk-res', ${tenantId}, 'model', 'text', 'openai', '["stream"]'::jsonb, 1)`;
  const rows = await client`
    INSERT INTO upstream_channel (resource_id, provider_type, weight, status)
    VALUES ('brk-res', 'openai', 1, 'active')
    RETURNING id`;
  const id = rows[0]?.id as string | undefined;
  if (id === undefined) throw new Error('upstream_channel insert returned no row');
  channelId = id;
});

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE channel_breaker, audit_log, route_group_channel, route_group, api_key, upstream_channel, resource_version, resource, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
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

describe('admin breaker status surface (弹性2.0)', () => {
  it('returns an empty list when no breaker has tripped', async () => {
    const res = await auth(request(app.getHttpServer()).get('/admin/breakers')).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('rejects a non-admin (user) JWT', async () => {
    await request(app.getHttpServer())
      .get('/admin/breakers')
      .set('authorization', `Bearer ${userToken()}`)
      .expect((res) => {
        expect([401, 403]).toContain(res.status);
      });
  });

  // 批次6 D3: the channel-name join target (`upstream_channel`) is deleted —
  // the view's channel_name/resource_id degrade to null; the FSM facts remain.
  it('lists a tripped breaker with its FSM facts', async () => {
    const now = new Date();
    await upsertBreaker(db, {
      channelId,
      model: 'gpt-4o',
      state: 'open',
      openedAt: now,
      cooldownUntil: new Date(now.getTime() + 60_000),
      tripCount: 2,
      halfOpenSuccesses: 0,
      now,
    });

    const res = await auth(request(app.getHttpServer()).get('/admin/breakers')).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      channel_id: channelId,
      model: 'gpt-4o',
      state: 'open',
      trip_count: 2,
      half_open_successes: 0,
    });
    expect(res.body[0].cooldown_until).not.toBeNull();
    // The recent-window failure_rate is always present (spec §⑤). This row was
    // seeded straight into PG with no Redis window, so the live rate is 0 (window
    // empty) or null (Redis unreachable in CI) — but never absent.
    expect(res.body[0]).toHaveProperty('failure_rate');
    expect([0, null]).toContain(res.body[0].failure_rate);
  });

  it('resets a breaker back to closed (deletes the row) + emits an audit_log', async () => {
    const now = new Date();
    await upsertBreaker(db, {
      channelId,
      model: 'gpt-4o',
      state: 'open',
      openedAt: now,
      cooldownUntil: new Date(now.getTime() + 60_000),
      tripCount: 3,
      halfOpenSuccesses: 0,
      now,
    });

    await auth(
      request(app.getHttpServer()).post(
        `/admin/breakers/${channelId}/${encodeURIComponent('gpt-4o')}/reset`,
      ),
    ).expect(204);

    // The row is gone (absence == closed), so the status surface is empty again.
    const after = await auth(request(app.getHttpServer()).get('/admin/breakers')).expect(200);
    expect(after.body).toHaveLength(0);

    // 记录系统: a `breaker.reset` audit row was appended for the channel. The
    // @Audit write is fire-and-forget (after the response), so poll for it.
    let audit =
      await client`SELECT action, target_type, target_id, meta FROM audit_log WHERE action = 'breaker.reset'`;
    for (let attempt = 0; attempt < 40 && audit.length < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      audit =
        await client`SELECT action, target_type, target_id, meta FROM audit_log WHERE action = 'breaker.reset'`;
    }
    expect(audit).toHaveLength(1);
    const row = audit[0];
    expect(row).toBeDefined();
    expect(row?.target_type).toBe('channel_breaker');
    expect(row?.target_id).toBe(channelId);
    expect(row?.meta).toMatchObject({ model: 'gpt-4o' });
  });
});
