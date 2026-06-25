import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { createSubUser, findUserByEmail, schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
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
import { DB, ENV, JOB_QUEUE, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';

const CREDIT_RATE = 10_000n;
const PROVIDER_REF = 'sess_console_subjects_e2e';
const EVENT_ID = 'evt_console_subjects_e2e';
const ADMIN_SECRET = 'console-subjects-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
const jwt = new JwtService({ secret: ADMIN_SECRET });

const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('console path must not enqueue')),
};

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
  await client`TRUNCATE TABLE subject, file_object, api_key, ledger_txn, payment_intent, payment_event, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/**
 * Self-register a brand-new user via `/auth/register` (provisions a tenant +
 * account, and the registrant is its tenant ADMIN per the rbac self-register
 * change). Returns its USER JWT and the resolved tenant id.
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

/**
 * Seed a tenant MEMBER (role=user, tenant_role=member) directly under an existing
 * tenant and sign its USER JWT (`{sub, role:'user'}` against ADMIN_JWT_SECRET) —
 * the same claim shape the ConsoleGuard accepts. The member is the non-admin seat
 * used to assert the TenantAdminGuard 403s.
 */
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

describe('/console/subjects (tenant-scoped subject crud + tenant-admin gate)', () => {
  it('a tenant ADMIN can create, list, get, patch, and delete its own subjects', async () => {
    const { token } = await registerAdmin('admin@example.com');

    const created = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${token}`)
      .send({ externalId: 'enduser-1', displayName: 'End User One' })
      .expect(201);
    expect(created.body.id).toBeTypeOf('string');
    expect(created.body.external_id).toBe('enduser-1');
    expect(created.body.display_name).toBe('End User One');
    expect(created.body.status).toBe('active');
    expect(created.body).not.toHaveProperty('password_hash');
    const subjectId = created.body.id as string;

    const listed = await request(server())
      .get('/console/subjects')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(subjectId);
    expect(listed.body.data[0]).not.toHaveProperty('password_hash');

    const fetched = await request(server())
      .get(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(fetched.body.id).toBe(subjectId);

    const patched = await request(server())
      .patch(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ displayName: 'Renamed', status: 'disabled' })
      .expect(200);
    expect(patched.body.display_name).toBe('Renamed');
    expect(patched.body.status).toBe('disabled');

    const deleted = await request(server())
      .delete(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(deleted.body).toEqual({ id: subjectId, status: 'deleted' });

    // After soft-delete the subject is gone from the tenant list.
    const afterDelete = await request(server())
      .get('/console/subjects')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterDelete.body.data).toHaveLength(0);
  });

  it("a tenant cannot see another tenant's subject (cross-tenant → 404)", async () => {
    const { token: tokenA } = await registerAdmin('admin-a@example.com');
    const { token: tokenB } = await registerAdmin('admin-b@example.com');

    const created = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${tokenA}`)
      .send({ externalId: 'a-enduser', displayName: 'Tenant A user' })
      .expect(201);
    const subjectId = created.body.id as string;

    // Tenant B's admin sees none of tenant A's subjects.
    const listedB = await request(server())
      .get('/console/subjects')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(listedB.body.data).toHaveLength(0);

    // Direct id access from tenant B → 404 (never leaks the row).
    const getB = await request(server())
      .get(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404);
    expect(getB.body.error.code).toBe('resource_not_found');

    // Patch + delete from tenant B → 404 too (no cross-tenant mutation).
    await request(server())
      .patch(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ displayName: 'hijack' })
      .expect(404);
    await request(server())
      .delete(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404);

    // Tenant A still owns an intact subject.
    const stillThere = await request(server())
      .get(`/console/subjects/${subjectId}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(stillThere.body.display_name).toBe('Tenant A user');
  });

  it('a tenant MEMBER is 403 on subject writes (admin-only)', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('admin-m@example.com');
    const memberToken = await seedMemberToken(tenantId, 'member-m@example.com', 'memberPass1');

    // Seed a subject as the admin so the member has a real id to attempt against.
    const created = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ externalId: 'm-enduser' })
      .expect(201);
    const subjectId = created.body.id as string;

    for (const [method, path, body] of [
      ['post', '/console/subjects', { externalId: 'member-made' }],
      ['patch', `/console/subjects/${subjectId}`, { displayName: 'nope' }],
      ['delete', `/console/subjects/${subjectId}`, {}],
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
