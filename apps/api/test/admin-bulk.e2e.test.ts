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

  // A chat resource the models/channels live under.
  await request(app.getHttpServer())
    .post('/admin/resources')
    .set('authorization', `Bearer ${token}`)
    .send({
      id: 'bulk-res',
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
  await client`TRUNCATE TABLE audit_log, request_idempotency, model_grant, model, api_key, ledger_txn, pricebook_entry, channel_model, upstream_channel, resource_version, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

async function createModel(name: string): Promise<void> {
  await auth(
    request(app.getHttpServer()).post('/admin/models').send({ name, resourceId: 'bulk-res' }),
  ).expect(201);
}

async function createChannel(): Promise<string> {
  const ch = await auth(
    request(app.getHttpServer())
      .post('/admin/resources/bulk-res/channels')
      .send({ providerType: 'openai' }),
  ).expect(201);
  return ch.body.id as string;
}

describe('bulk models (partial success + per-entity audit)', () => {
  it('disables a batch [real, real, bogus] → succeeded=[2], failed=[bogus], rows disabled, an audit row each', async () => {
    await createModel('bulk-m1');
    await createModel('bulk-m2');

    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/models/bulk')
        .send({ ids: ['bulk-m1', 'bulk-m2', 'nope'], action: 'disable' }),
    ).expect(200);

    expect(res.body.succeeded).toEqual(expect.arrayContaining(['bulk-m1', 'bulk-m2']));
    expect(res.body.succeeded).toHaveLength(2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe('nope');
    expect(typeof res.body.failed[0].error).toBe('string');

    // The two real models are now `disabled`.
    const m1 = await auth(request(app.getHttpServer()).get('/admin/models/bulk-m1')).expect(200);
    const m2 = await auth(request(app.getHttpServer()).get('/admin/models/bulk-m2')).expect(200);
    expect(m1.body.status).toBe('disabled');
    expect(m2.body.status).toBe('disabled');

    // One audit_log row PER disabled model (action `model.disable`).
    const rows = await client<{ target_id: string; action: string; actor_type: string }[]>`
      SELECT target_id, action, actor_type FROM audit_log
      WHERE target_type = 'model' AND action = 'model.disable'`;
    const ids = rows.map((r) => r.target_id);
    expect(ids).toEqual(expect.arrayContaining(['bulk-m1', 'bulk-m2']));
    expect(rows.filter((r) => r.action === 'model.disable')).toHaveLength(2);
    expect(rows.every((r) => r.actor_type === 'operator')).toBe(true);
    // The bogus id never produced an audit row.
    expect(ids).not.toContain('nope');
  });

  it('enables then deletes a batch (delete soft-deletes + delists)', async () => {
    await createModel('bulk-e1');
    await createModel('bulk-e2');

    const enabled = await auth(
      request(app.getHttpServer())
        .post('/admin/models/bulk')
        .send({ ids: ['bulk-e1', 'bulk-e2'], action: 'enable' }),
    ).expect(200);
    expect(enabled.body.succeeded).toHaveLength(2);
    expect(enabled.body.failed).toHaveLength(0);

    const deleted = await auth(
      request(app.getHttpServer())
        .post('/admin/models/bulk')
        .send({ ids: ['bulk-e1', 'bulk-e2'], action: 'delete' }),
    ).expect(200);
    expect(deleted.body.succeeded).toHaveLength(2);

    // Both delisted (soft-deleted) — GET-by-name now 404.
    await auth(request(app.getHttpServer()).get('/admin/models/bulk-e1')).expect(404);
    await auth(request(app.getHttpServer()).get('/admin/models/bulk-e2')).expect(404);
  });

  it('rejects an empty ids[] (400)', async () => {
    await auth(
      request(app.getHttpServer()).post('/admin/models/bulk').send({ ids: [], action: 'disable' }),
    ).expect(400);
  });
});

describe('bulk channels (smoke)', () => {
  it('disables a batch [real, bogus] → succeeded=[1], failed=[bogus] + an audit row', async () => {
    const channelId = await createChannel();

    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/channels/bulk')
        .send({ ids: [channelId, 'no-such-channel'], action: 'disable' }),
    ).expect(200);

    expect(res.body.succeeded).toEqual([channelId]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe('no-such-channel');

    const rows = await client<{ target_id: string }[]>`
      SELECT target_id FROM audit_log WHERE target_type = 'channel' AND action = 'channel.disable'`;
    expect(rows.map((r) => r.target_id)).toEqual([channelId]);
  });

  it('deletes a batch (soft-delete drops it from the resource listing)', async () => {
    const channelId = await createChannel();
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/channels/bulk')
        .send({ ids: [channelId], action: 'delete' }),
    ).expect(200);
    expect(res.body.succeeded).toEqual([channelId]);

    const list = await auth(
      request(app.getHttpServer()).get('/admin/resources/bulk-res/channels'),
    ).expect(200);
    expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(channelId);
  });
});

describe('bulk oauth-sessions (smoke)', () => {
  it('revoke of bogus ids → all in failed (partial-success, never aborts)', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/bulk')
        .send({ ids: ['nope-1', 'nope-2'], action: 'revoke' }),
    ).expect(200);
    expect(res.body.succeeded).toEqual([]);
    expect(res.body.failed.map((f: { id: string }) => f.id)).toEqual(
      expect.arrayContaining(['nope-1', 'nope-2']),
    );
  });
});
