import { insertUsageLog, schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
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
import { DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';

const ADMIN_SECRET = 'member-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
const jwt = new JwtService({ secret: ADMIN_SECRET });

const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('member path must not enqueue')),
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(pg.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(JOB_QUEUE)
    .useValue(noopQueue)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 0,
      LOG_LEVEL: 'info',
      ALLOW_DEV_TENANT_HEADER: false,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
      STORAGE_PUBLIC_BASE_URL: 'https://asset.example',
      AUTH_RATE_LIMIT_PER_MIN: 1000,
      CREDIT_RATE: 10000,
    })
    .compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await pg.stop();
});

afterEach(async () => {
  // Let the fire-and-forget audit inserts drain before the FK-cascade TRUNCATE.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client`TRUNCATE TABLE audit_log, sub_account, subject, file_object, api_key, ledger_txn, usage_log, payment_intent, payment_event, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/**
 * Self-register a brand-new user via `/auth/register` (provisions a tenant +
 * account; the registrant is its tenant ADMIN). Returns its USER JWT (the
 * operator token) + the resolved tenant id.
 */
async function registerAdmin(
  email: string,
  password = 'sup3rSecret',
): Promise<{ token: string; tenantId: string }> {
  const res = await request(server()).post('/auth/register').send({ email, password }).expect(200);
  const me = await request(server())
    .get('/console/me')
    .set('authorization', `Bearer ${res.body.token as string}`)
    .expect(200);
  return { token: res.body.token as string, tenantId: me.body.tenant_id as string };
}

/** Create a subject (end-user) under `token`'s tenant; returns its id. */
async function makeSubject(token: string, externalId: string): Promise<string> {
  const created = await request(server())
    .post('/console/subjects')
    .set('authorization', `Bearer ${token}`)
    .send({ externalId })
    .expect(201);
  return created.body.id as string;
}

/**
 * Sign a MEMBER JWT (`{sub, tenant_id, typ:'subject'}` against ADMIN_JWT_SECRET) —
 * the exact claim shape `LocalAuthService.issueMemberToken` signs and the
 * MemberGuard accepts. Mints the token for an already-created subject.
 */
function memberToken(subjectId: string, tenantId: string): string {
  return jwt.sign({ sub: subjectId, tenant_id: tenantId, typ: 'subject' });
}

describe('/member/* (end-user read-only self-service, subject-scoped)', () => {
  it('returns ONLY the calling subject own identity / usage / balance / keys / limits', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('member-admin@example.com');

    // Two subjects in the SAME tenant — A is the caller, B is the other end-user.
    const subjectA = await makeSubject(adminToken, 'enduser-a');
    const subjectB = await makeSubject(adminToken, 'enduser-b');

    // A gets a HARD sub-wallet (10 credits) + a subject-scoped key; B gets its own key.
    await request(server())
      .post(`/console/subjects/${subjectA}/sub-account/open`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ credits: 10 })
      .expect(201);
    const keyA = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ subjectId: subjectA })
      .expect(201);
    await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ subjectId: subjectB })
      .expect(201);

    // Seed one usage_log row for EACH subject (same tenant).
    await insertUsageLog(db, {
      tenantId,
      subjectId: subjectA,
      model: 'gpt-a',
      inputTokens: 10,
      outputTokens: 20,
      cost: 1234n,
      status: 'succeeded',
    });
    await insertUsageLog(db, {
      tenantId,
      subjectId: subjectB,
      model: 'gpt-b',
      inputTokens: 5,
      outputTokens: 6,
      cost: 9999n,
      status: 'succeeded',
    });

    const tokenA = memberToken(subjectA, tenantId);

    // GET /member/me → A's own identity, never a hash.
    const me = await request(server())
      .get('/member/me')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(me.body.id).toBe(subjectA);
    expect(me.body.tenant_id).toBe(tenantId);
    expect(me.body.external_id).toBe('enduser-a');
    expect(me.body).not.toHaveProperty('password_hash');

    // GET /member/usage → ONLY A's row (B's row is never visible).
    const usage = await request(server())
      .get('/member/usage')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(usage.body.data).toHaveLength(1);
    expect(usage.body.data[0].model).toBe('gpt-a');
    expect(usage.body.data[0].cost).toBe('1234');
    expect(usage.body.data[0]).not.toHaveProperty('subject_id');

    // GET /member/balance → A's HARD sub-wallet (10 credits = 10_000_000 µcredits).
    const balance = await request(server())
      .get('/member/balance')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(balance.body.mode).toBe('hard');
    expect(balance.body.balance).toBe('10000000');

    // GET /member/api-keys → ONLY A's key (masked, never plaintext/hash).
    const keys = await request(server())
      .get('/member/api-keys')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(keys.body).toHaveLength(1);
    expect(keys.body[0].id).toBe(keyA.body.id);
    expect(keys.body[0]).not.toHaveProperty('key');
    expect(keys.body[0]).not.toHaveProperty('hash');
    expect(keys.body[0].last4).toBeTypeOf('string');

    // GET /member/limits → A has no bound plan → null plan + empty rules.
    const limits = await request(server())
      .get('/member/limits')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(limits.body.plan).toBeNull();
    expect(limits.body.rules).toEqual([]);
  });

  it('reports mode:shared when the subject has no hard sub-wallet', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('member-shared@example.com');
    const subjectId = await makeSubject(adminToken, 'shared-subj');
    const token = memberToken(subjectId, tenantId);

    const balance = await request(server())
      .get('/member/balance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(balance.body.mode).toBe('shared');
    expect(balance.body.balance).toBe('0');
    expect(balance.body.held).toBe('0');
  });

  it('an OPERATOR token is rejected on /member/* (401)', async () => {
    const { token: operatorToken } = await registerAdmin('member-op@example.com');

    for (const path of [
      '/member/me',
      '/member/usage',
      '/member/balance',
      '/member/api-keys',
      '/member/limits',
    ]) {
      const res = await request(server())
        .get(path)
        .set('authorization', `Bearer ${operatorToken}`)
        .expect(401);
      expect(res.body.error.code).toBe('unauthorized');
    }
  });

  it('a member token is rejected on the /console operator plane (401)', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('member-cross@example.com');
    const subjectId = await makeSubject(adminToken, 'cross-subj');
    const token = memberToken(subjectId, tenantId);

    // The member token carries no `{role}` → ConsoleGuard rejects it.
    await request(server()).get('/console/me').set('authorization', `Bearer ${token}`).expect(401);
  });
});
