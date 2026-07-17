import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { createSubUser, findUserByEmail, schema } from '@actionow/db';
import { PaymentService } from '@actionow/engine';
import { FakeRateLimitRedis, hashPassword, RedisRateLimiter } from '@actionow/infra';
import type { PaymentProvider, PaymentRegistry } from '@actionow/payments';
import { SignatureVerificationError } from '@actionow/payments';
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
import { DB, ENV, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const CREDIT_RATE = 10_000n;
const PROVIDER_REF = 'sess_console_limit_plans_e2e';
const EVENT_ID = 'evt_console_limit_plans_e2e';
const ADMIN_SECRET = 'console-limit-plans-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
const jwt = new JwtService({ secret: ADMIN_SECRET });

const fakeProvider: PaymentProvider = {
  kind: 'stripe',
  createIntent(): Promise<IntentResult> {
    return Promise.resolve({
      providerRef: PROVIDER_REF,
      redirectUrl: 'https://checkout.example/console',
    });
  },
  verifyWebhook(rawBody: Buffer | string): Promise<VerifiedEvent> {
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    if (body.includes('forged')) return Promise.reject(new SignatureVerificationError());
    return Promise.resolve({
      eventId: EVENT_ID,
      type: 'checkout.session.completed',
      providerRef: PROVIDER_REF,
      status: 'succeeded',
    });
  },
};

const fakeRegistry: PaymentRegistry = {
  get(kind: PaymentProviderKind): PaymentProvider {
    if (kind !== 'stripe') throw new Error(`unexpected provider ${kind}`);
    return fakeProvider;
  },
  has(kind: PaymentProviderKind): boolean {
    return kind === 'stripe';
  },
  configuredKinds(): PaymentProviderKind[] {
    return ['stripe'];
  },
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(pg.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const paymentsService = new PaymentService({
    db,
    providers: fakeRegistry,
    creditRate: CREDIT_RATE,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(PAYMENTS)
    .useValue(paymentsService)
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
  // The AuditInterceptor appends audit_log rows fire-and-forget AFTER the
  // response is sent; let them drain before TRUNCATE so the FK-cascade truncate
  // of audit_log doesn't deadlock against an in-flight INSERT.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await resetDb(
    () =>
      client`TRUNCATE TABLE audit_log, limit_rule, limit_plan, subject, file_object, api_key, ledger_txn, payment_intent, payment_event, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/**
 * Self-register a brand-new user via `/auth/register` (provisions a tenant +
 * account, and the registrant is its tenant ADMIN). Returns its USER JWT + tenant id.
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

/** Seed a tenant MEMBER (role=user, tenant_role=member) + sign its USER JWT. */
async function seedMemberToken(
  tenantId: string,
  email: string,
  password = 'memberPass1',
): Promise<string> {
  await createSubUser(db, { tenantId, email, passwordHash: hashPassword(password) });
  const member = await findUserByEmail(db, email);
  if (member === undefined) throw new Error('seeded member not found');
  return jwt.sign({ sub: member.id, role: 'user' });
}

/** A minimal valid plan body (one spend/day rule). */
function planBody(name: string): {
  name: string;
  description: string;
  rules: { dimension: 'spend'; period: 'day'; cap: number }[];
} {
  return {
    name,
    description: `plan ${name}`,
    rules: [{ dimension: 'spend', period: 'day', cap: 1_000_000 }],
  };
}

describe('/console/limit-plans (tenant-owned plan crud + subject binding)', () => {
  it('a tenant ADMIN can create, list, get, patch, and delete its own plans', async () => {
    const { token, tenantId } = await registerAdmin('plan-admin@example.com');

    const created = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${token}`)
      .send(planBody('pro'))
      .expect(201);
    expect(created.body.id).toBeTypeOf('string');
    expect(created.body.name).toBe('pro');
    expect(created.body.tenant_id).toBe(tenantId);
    expect(created.body.rules).toHaveLength(1);
    expect(created.body.rules[0].dimension).toBe('spend');
    const planId = created.body.id as string;

    const listed = await request(server())
      .get('/console/limit-plans')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(planId);
    expect(listed.body[0].tenant_id).toBe(tenantId);

    const fetched = await request(server())
      .get(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(fetched.body.id).toBe(planId);

    const patched = await request(server())
      .patch(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'pro-renamed', status: 'disabled' })
      .expect(200);
    expect(patched.body.name).toBe('pro-renamed');
    expect(patched.body.status).toBe('disabled');
    expect(patched.body.tenant_id).toBe(tenantId);

    await request(server())
      .delete(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(204);

    const afterDelete = await request(server())
      .get('/console/limit-plans')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterDelete.body).toHaveLength(0);
  });

  it("lists only OWN plans — not platform plans, not other tenants'", async () => {
    const { token: tokenA, tenantId: tenantA } = await registerAdmin('plan-a@example.com');
    const { token: tokenB } = await registerAdmin('plan-b@example.com');

    // A platform plan (tenant_id NULL) seeded directly — invisible on /console.
    const { createLimitPlan } = await import('@actionow/db');
    await createLimitPlan(db, { name: 'platform-free' });

    // Two tenants may BOTH have a plan named 'pro' (per-(tenant,name) unique).
    const createdA = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${tokenA}`)
      .send(planBody('pro'))
      .expect(201);
    await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${tokenB}`)
      .send(planBody('pro'))
      .expect(201);

    const listedA = await request(server())
      .get('/console/limit-plans')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(listedA.body).toHaveLength(1);
    expect(listedA.body[0].id).toBe(createdA.body.id);
    expect(listedA.body[0].tenant_id).toBe(tenantA);
    expect(listedA.body.every((p: { name: string }) => p.name !== 'platform-free')).toBe(true);
  });

  it("rejects get/patch/delete of ANOTHER tenant's plan (cross-tenant → 404)", async () => {
    const { token: tokenA } = await registerAdmin('plan-x-a@example.com');
    const { token: tokenB } = await registerAdmin('plan-x-b@example.com');

    const created = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${tokenA}`)
      .send(planBody('pro'))
      .expect(201);
    const planId = created.body.id as string;

    const getB = await request(server())
      .get(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404);
    expect(getB.body.error.code).toBe('resource_not_found');

    await request(server())
      .patch(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404);

    // Tenant A still owns its intact plan.
    await request(server())
      .get(`/console/limit-plans/${planId}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
  });

  it('rejects deleting/patching a PLATFORM plan from /console (cross-tenant → 404)', async () => {
    const { token } = await registerAdmin('plan-plat@example.com');
    const { createLimitPlan } = await import('@actionow/db');
    const platform = await createLimitPlan(db, { name: 'platform-pro' });

    await request(server())
      .get(`/console/limit-plans/${platform.id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(404);
    await request(server())
      .patch(`/console/limit-plans/${platform.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/console/limit-plans/${platform.id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(404);
  });

  it("binds a tenant plan to one of the tenant's subjects, then unbinds (planId null)", async () => {
    const { token } = await registerAdmin('plan-bind@example.com');

    const subject = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${token}`)
      .send({ externalId: 'bind-subj' })
      .expect(201);
    const subjectId = subject.body.id as string;

    const plan = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${token}`)
      .send(planBody('pro'))
      .expect(201);
    const planId = plan.body.id as string;

    await request(server())
      .post(`/console/subjects/${subjectId}/limit-plan`)
      .set('authorization', `Bearer ${token}`)
      .send({ planId })
      .expect(200);

    const bound = await request(server())
      .get(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(bound.body.limit_plan_id).toBe(planId);

    // Usage-vs-cap bars: the bound plan's rules surface (used starts at 0).
    const status = await request(server())
      .get(`/console/subjects/${subjectId}/limit-status`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(status.body)).toBe(true);
    expect(status.body.length).toBeGreaterThan(0);
    expect(status.body[0]).toHaveProperty('used');
    expect(status.body[0]).toHaveProperty('cap');

    // Unbind (planId null).
    await request(server())
      .post(`/console/subjects/${subjectId}/limit-plan`)
      .set('authorization', `Bearer ${token}`)
      .send({ planId: null })
      .expect(200);
    const unbound = await request(server())
      .get(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(unbound.body.limit_plan_id).toBeNull();
  });

  it("limit-status is tenant-scoped: another tenant's subject → 404", async () => {
    const { token: tokenA } = await registerAdmin('ls-a@example.com');
    const { token: tokenB } = await registerAdmin('ls-b@example.com');
    const subjectB = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${tokenB}`)
      .send({ externalId: 'ls-b-subj' })
      .expect(201);
    await request(server())
      .get(`/console/subjects/${subjectB.body.id as string}/limit-status`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(404);
  });

  it('rejects binding a plan NOT owned by the tenant (cross-tenant plan → 404)', async () => {
    const { token: tokenA } = await registerAdmin('plan-rb-a@example.com');
    const { token: tokenB } = await registerAdmin('plan-rb-b@example.com');

    const subjectB = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${tokenB}`)
      .send({ externalId: 'b-subj' })
      .expect(201);
    const subjectBId = subjectB.body.id as string;

    // Tenant A's plan id may not be bound to tenant B's subject.
    const planA = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${tokenA}`)
      .send(planBody('pro'))
      .expect(201);

    const res = await request(server())
      .post(`/console/subjects/${subjectBId}/limit-plan`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ planId: planA.body.id })
      .expect(404);
    expect(res.body.error.code).toBe('resource_not_found');

    // …and the subject stays unbound.
    const stillUnbound = await request(server())
      .get(`/console/subjects/${subjectBId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(stillUnbound.body.limit_plan_id).toBeNull();
  });

  it("rejects binding a plan to ANOTHER tenant's subject (cross-tenant subject → 404)", async () => {
    const { token: tokenA } = await registerAdmin('plan-rs-a@example.com');
    const { token: tokenB } = await registerAdmin('plan-rs-b@example.com');

    const subjectA = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${tokenA}`)
      .send({ externalId: 'a-subj' })
      .expect(201);
    const subjectAId = subjectA.body.id as string;
    const planB = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${tokenB}`)
      .send(planBody('pro'))
      .expect(201);

    // Tenant B can neither name tenant A's subject nor reach it.
    await request(server())
      .post(`/console/subjects/${subjectAId}/limit-plan`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ planId: planB.body.id })
      .expect(404);
  });

  it('a tenant MEMBER is 403 on every plan write + the binding (admin-only)', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('plan-m@example.com');
    const memberToken = await seedMemberToken(tenantId, 'plan-member@example.com', 'memberPass1');

    const subject = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ externalId: 'm-subj' })
      .expect(201);
    const plan = await request(server())
      .post('/console/limit-plans')
      .set('authorization', `Bearer ${adminToken}`)
      .send(planBody('pro'))
      .expect(201);
    const subjectId = subject.body.id as string;
    const planId = plan.body.id as string;

    for (const [method, path, body] of [
      ['post', '/console/limit-plans', planBody('member-made')],
      ['patch', `/console/limit-plans/${planId}`, { name: 'nope' }],
      ['delete', `/console/limit-plans/${planId}`, {}],
      ['post', `/console/subjects/${subjectId}/limit-plan`, { planId }],
    ] as const) {
      const res = await request(server())
        [method](path)
        .set('authorization', `Bearer ${memberToken}`)
        .send(body)
        .expect(403);
      expect(res.body.error.code).toBe('forbidden');
    }
  });
});
