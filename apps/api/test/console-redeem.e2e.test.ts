import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { createSubUser, createUser, findUserByEmail, schema } from '@actionow/db';
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
const PROVIDER_REF = 'sess_console_redeem_e2e';
const EVENT_ID = 'evt_console_redeem_e2e';
const ADMIN_SECRET = 'console-redeem-e2e-secret';
const ADMIN_EMAIL = 'platform-admin@example.com';
const ADMIN_PASSWORD = 'adminSup3rSecret';

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
      client`TRUNCATE TABLE audit_log, redemption_code, subject, file_object, api_key, ledger_txn, payment_intent, payment_event, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/**
 * Seed a PLATFORM admin (role=admin) directly and log it in via the real
 * `/admin/auth/login` route to obtain an admin JWT — the token used to MINT
 * redemption codes through `POST /admin/redemption-codes`.
 */
async function adminToken(): Promise<string> {
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const res = await request(server())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  return res.body.token as string;
}

/**
 * Self-register a brand-new operator via `/auth/register` (provisions a tenant +
 * account; the registrant is its tenant ADMIN). Returns its USER JWT.
 */
async function registerOperator(email: string, password = 'sup3rSecret'): Promise<string> {
  const res = await request(server()).post('/auth/register').send({ email, password }).expect(200);
  return res.body.token as string;
}

/**
 * Seed a tenant MEMBER (role=user, tenant_role=member) under an existing tenant
 * and sign its USER JWT — the non-admin seat used to assert the TenantAdminGuard
 * 403s on `POST /console/redeem`.
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

/** Mint `count` codes with `creditsPerCode` (+ optional ISO expiry) as the admin; returns the codes. */
async function mintCodes(
  token: string,
  body: { count: number; creditsPerCode: number; expiresAt?: string },
): Promise<string[]> {
  const res = await request(server())
    .post('/admin/redemption-codes')
    .set('authorization', `Bearer ${token}`)
    .send(body)
    .expect(201);
  return res.body.codes as string[];
}

describe('POST /console/redeem (gift-code redemption; atomic, single-use, tenant-admin gate)', () => {
  it('an operator redeems a minted code → 200, credits the tenant, balance increases by the grant', async () => {
    const admin = await adminToken();
    const opToken = await registerOperator('redeem-op@example.com');

    // baseline tenant balance (a fresh self-registered tenant starts at 0).
    const before = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    const beforeBalance = BigInt(before.body.balance as string);

    // admin mints a 5-credit code → 5 * 1_000_000 = 5_000_000 µcredits.
    const [code] = await mintCodes(admin, { count: 1, creditsPerCode: 5 });

    const redeemed = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code })
      .expect(200);
    expect(redeemed.body.credited).toBe('5000000');
    expect(BigInt(redeemed.body.balance as string)).toBe(beforeBalance + 5_000_000n);

    // GET /console/balance reflects the grant.
    const after = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    expect(BigInt(after.body.balance as string)).toBe(beforeBalance + 5_000_000n);
  });

  it('re-redeeming the SAME code → 400 already-redeemed, and no double-credit', async () => {
    const admin = await adminToken();
    const opToken = await registerOperator('redeem-twice@example.com');
    const [code] = await mintCodes(admin, { count: 1, creditsPerCode: 3 });

    await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code })
      .expect(200);

    const afterFirst = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    const balanceAfterFirst = afterFirst.body.balance as string;

    const second = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code })
      .expect(400);
    expect(second.body.error.code).toBe('invalid_input');
    expect(second.body.error.message).toMatch(/already redeemed/);

    // The rejected re-redeem left the balance untouched (no double-credit).
    const afterSecond = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    expect(afterSecond.body.balance).toBe(balanceAfterFirst);
  });

  it('an unknown code → 404 resource_not_found (and never credits)', async () => {
    const opToken = await registerOperator('redeem-unknown@example.com');

    const before = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);

    const res = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code: 'NO-SUCH-CODE' })
      .expect(404);
    expect(res.body.error.code).toBe('resource_not_found');
    expect(res.body.error.message).toMatch(/not found/);

    const after = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    expect(after.body.balance).toBe(before.body.balance);
  });

  it('an EXPIRED code → 400 invalid_input (and never credits)', async () => {
    const admin = await adminToken();
    const opToken = await registerOperator('redeem-expired@example.com');

    const before = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);

    // Mint with an expiry in the past → the conditional claim UPDATE matches
    // nothing → disambiguated as `expired`.
    const [code] = await mintCodes(admin, {
      count: 1,
      creditsPerCode: 9,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    const res = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toMatch(/expired/);

    const after = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    expect(after.body.balance).toBe(before.body.balance);
  });

  it('a tenant MEMBER (non-admin) is 403 on redeem (admin-only)', async () => {
    const admin = await adminToken();
    const opRes = await request(server())
      .post('/auth/register')
      .send({ email: 'redeem-tenant@example.com', password: 'sup3rSecret' })
      .expect(200);
    const opToken = opRes.body.token as string;
    const me = await request(server())
      .get('/console/me')
      .set('authorization', `Bearer ${opToken}`)
      .expect(200);
    const memberToken = await seedMemberToken(
      me.body.tenant_id as string,
      'redeem-member@example.com',
    );

    const [code] = await mintCodes(admin, { count: 1, creditsPerCode: 5 });

    const res = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${memberToken}`)
      .send({ code })
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');

    // The member's 403 must NOT have consumed the code — the admin can still
    // hand it to the tenant admin, who redeems it successfully.
    const redeemed = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code })
      .expect(200);
    expect(redeemed.body.credited).toBe('5000000');
  });

  it('a blank code is rejected by the contract (400 invalid_input)', async () => {
    const opToken = await registerOperator('redeem-blank@example.com');
    const res = await request(server())
      .post('/console/redeem')
      .set('authorization', `Bearer ${opToken}`)
      .send({ code: '   ' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});
