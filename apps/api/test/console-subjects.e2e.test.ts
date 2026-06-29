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
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, JOB_QUEUE, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

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
  // The AuditInterceptor appends audit_log rows fire-and-forget AFTER the
  // response is sent (`void this.audit.record(...)`). The sub-wallet routes emit
  // such rows on a separate connection; let them drain before TRUNCATE so the
  // FK-cascade truncate of audit_log doesn't deadlock against an in-flight INSERT.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await resetDb(
    () =>
      client`TRUNCATE TABLE audit_log, subject, file_object, api_key, ledger_txn, payment_intent, payment_event, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
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
 * Fund a tenant's pool account directly (test-only). Conserving sub-wallet
 * allocations (open opening-balance / topup) debit this pool, so it must hold
 * credit before a tenant-admin can allocate to a subject.
 */
async function fundTenantPool(tenantId: string, credits: number): Promise<void> {
  await db
    .update(schema.account)
    .set({ creditBalance: BigInt(credits) * 1_000_000n })
    .where(eq(schema.account.tenantId, tenantId));
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

describe('/console subject-scoped keys + sub-wallet (tenant-scoped, tenant-admin gate)', () => {
  /** Create a subject under `token`'s tenant; returns its id. */
  async function makeSubject(token: string, externalId: string): Promise<string> {
    const created = await request(server())
      .post('/console/subjects')
      .set('authorization', `Bearer ${token}`)
      .send({ externalId })
      .expect(201);
    return created.body.id as string;
  }

  it('mints a subject-scoped api key and surfaces subject_id on the key view', async () => {
    const { token } = await registerAdmin('keys-admin@example.com');
    const subjectId = await makeSubject(token, 'key-subj');

    const minted = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${token}`)
      .send({ subjectId })
      .expect(201);
    expect(minted.body.plaintext).toMatch(/^ak_/);

    const listed = await request(server())
      .get('/console/api-keys')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(minted.body.id);
    expect(listed.body.data[0].subject_id).toBe(subjectId);

    // A tenant-level key (no subjectId) lands with subject_id null.
    const tenantKey = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    const afterTenantKey = await request(server())
      .get('/console/api-keys')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const plain = afterTenantKey.body.data.find((k: { id: string }) => k.id === tenantKey.body.id);
    expect(plain.subject_id).toBeNull();
  });

  it("rejects binding a key to ANOTHER tenant's subject (cross-tenant → 404)", async () => {
    const { token: tokenA } = await registerAdmin('keys-a@example.com');
    const { token: tokenB } = await registerAdmin('keys-b@example.com');
    const subjectA = await makeSubject(tokenA, 'a-subj');

    // Tenant B may not bind tenant A's subject id to a key.
    const res = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${tokenB}`)
      .send({ subjectId: subjectA })
      .expect(404);
    expect(res.body.error.code).toBe('resource_not_found');

    // …and no orphan key was minted for tenant B.
    const listedB = await request(server())
      .get('/console/api-keys')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(listedB.body.data).toHaveLength(0);
  });

  it('opens, reads, tops up, and transfers a subject sub-wallet (conserving: pool ↔ sub-wallet)', async () => {
    const { token, tenantId } = await registerAdmin('wallet-admin@example.com');
    const subjectId = await makeSubject(token, 'wallet-subj');
    // Fund the tenant pool — sub-wallet allocations DEBIT this pool (conserving).
    await fundTenantPool(tenantId, 20);

    // open with a 10-credit opening balance → sub-wallet 10cr, pool 20→10.
    const opened = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/open`)
      .set('authorization', `Bearer ${token}`)
      .send({ credits: 10 })
      .expect(201);
    expect(opened.body.subject_id).toBe(subjectId);
    expect(opened.body.credit_balance).toBe('10000000');

    // GET reflects the opened balance
    const got = await request(server())
      .get(`/console/subjects/${subjectId}/sub-account`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(got.body.credit_balance).toBe('10000000');

    // topup +5 → sub-wallet 15; pool 10→5 (allocation funded from the pool).
    const topped = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/topup`)
      .set('authorization', `Bearer ${token}`)
      .send({ credits: 5 })
      .expect(200);
    expect(topped.body.credit_balance).toBe('15000000');

    // The pool was debited by open(10) + topup(5) → 20 - 15 = 5cr left.
    const poolAfterAlloc = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(poolAfterAlloc.body.balance).toBe('5000000');

    // transfer 3 BACK to the tenant pool → sub-wallet 12; pool 5→8.
    const moved = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/transfer`)
      .set('authorization', `Bearer ${token}`)
      .send({ credits: 3, direction: 'to_tenant' })
      .expect(200);
    expect(moved.body.credit_balance).toBe('12000000');
    const poolAfterReturn = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(poolAfterReturn.body.balance).toBe('8000000');
  });

  it('sub-wallet allocation is conserving: a tenant-admin cannot MINT beyond the funded pool', async () => {
    const { token, tenantId } = await registerAdmin('wallet-mint@example.com');
    const subjectId = await makeSubject(token, 'mint-subj');

    // Pool is empty (0). open with an opening balance must be REJECTED (no mint),
    // and the wallet must NOT be left created (the whole allocation rolls back).
    const rejectedOpen = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/open`)
      .set('authorization', `Bearer ${token}`)
      .send({ credits: 1000 })
      .expect(400);
    expect(rejectedOpen.body.error.code).toBe('invalid_input');

    // open with NO opening balance is fine — creates the wallet, mints nothing.
    const opened = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/open`)
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect(opened.body.credit_balance).toBe('0');

    // topup beyond the (still empty) pool → rejected; nothing minted.
    const rejectedTopup = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/topup`)
      .set('authorization', `Bearer ${token}`)
      .send({ credits: 1000 })
      .expect(400);
    expect(rejectedTopup.body.error.code).toBe('invalid_input');
    const stillZero = await request(server())
      .get(`/console/subjects/${subjectId}/sub-account`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(stillZero.body.credit_balance).toBe('0');

    // Fund the pool, then a topup succeeds and DEBITS the pool one-for-one.
    await fundTenantPool(tenantId, 10);
    const topped = await request(server())
      .post(`/console/subjects/${subjectId}/sub-account/topup`)
      .set('authorization', `Bearer ${token}`)
      .send({ credits: 7 })
      .expect(200);
    expect(topped.body.credit_balance).toBe('7000000');
    const pool = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(pool.body.balance).toBe('3000000'); // 10 funded − 7 allocated
  });

  it("a tenant cannot read/mutate ANOTHER tenant's sub-wallet (cross-tenant → 404)", async () => {
    const { token: tokenA } = await registerAdmin('wallet-a@example.com');
    const { token: tokenB } = await registerAdmin('wallet-b@example.com');
    const subjectA = await makeSubject(tokenA, 'a-wallet');
    // Open with no opening balance (this test asserts cross-tenant isolation, not
    // balances — so it needs no funded pool).
    await request(server())
      .post(`/console/subjects/${subjectA}/sub-account/open`)
      .set('authorization', `Bearer ${tokenA}`)
      .send({})
      .expect(201);

    // Tenant B sees a 404 on every sub-wallet route addressed at tenant A's subject.
    await request(server())
      .get(`/console/subjects/${subjectA}/sub-account`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(404);
    await request(server())
      .post(`/console/subjects/${subjectA}/sub-account/open`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ credits: 1 })
      .expect(404);
    await request(server())
      .post(`/console/subjects/${subjectA}/sub-account/topup`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ credits: 1 })
      .expect(404);
    await request(server())
      .post(`/console/subjects/${subjectA}/sub-account/transfer`)
      .set('authorization', `Bearer ${tokenB}`)
      .send({ credits: 1, direction: 'to_tenant' })
      .expect(404);
  });

  it('a tenant MEMBER is 403 on key minting + every sub-wallet write (admin-only)', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('wallet-m@example.com');
    const memberToken = await seedMemberToken(tenantId, 'wallet-member@example.com', 'memberPass1');
    const subjectId = await makeSubject(adminToken, 'm-wallet');

    for (const [method, path, body] of [
      ['post', '/console/api-keys', { subjectId }],
      ['post', `/console/subjects/${subjectId}/sub-account/open`, { credits: 1 }],
      ['post', `/console/subjects/${subjectId}/sub-account/topup`, { credits: 1 }],
      [
        'post',
        `/console/subjects/${subjectId}/sub-account/transfer`,
        { credits: 1, direction: 'to_tenant' },
      ],
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
