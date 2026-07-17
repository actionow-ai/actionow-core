import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { createApiKey, createUser, schema } from '@actionow/db';
import { PaymentService } from '@actionow/engine';
import { FakeRateLimitRedis, hashPassword, RedisRateLimiter } from '@actionow/infra';
import type { PaymentProvider, PaymentRegistry } from '@actionow/payments';
import { SignatureVerificationError } from '@actionow/payments';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const { account, ledgerTxn, paymentEvent, paymentIntent, tenant } = schema;

const CREDIT_RATE = 10_000n; // µUSD per cent (1 cent → 10_000 µUSD; $1 → 1e6 µUSD)
const PROVIDER_REF = 'sess_e2e_123';
const EVENT_ID = 'evt_e2e_abc';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

/**
 * The fake provider injected for the e2e: `createIntent` returns a canned
 * providerRef/redirect (no real Stripe network); `verifyWebhook` returns a
 * canned succeeded event, or throws a {@link SignatureVerificationError} when the
 * raw body is the sentinel `'forged'` — letting the bad-signature test exercise
 * the 401 path without standing up real Stripe HMAC.
 */
const fakeProvider: PaymentProvider = {
  kind: 'stripe',
  createIntent(): Promise<IntentResult> {
    return Promise.resolve({
      providerRef: PROVIDER_REF,
      redirectUrl: 'https://checkout.example/sess_e2e_123',
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

const ADMIN_SECRET = 'test-admin-secret';

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
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
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

beforeEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE payment_event, payment_intent, ledger_txn, api_key, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

const ADMIN_EMAIL = 'admin@actionow.local';
const ADMIN_PASSWORD = 'hunter2';

/** Seed an admin user and log in for a signed admin JWT. */
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

/** Seed a tenant + its billing account (the ApiKeyGuard requires an account). */
async function seedTenant(name: string, opening = 0n): Promise<string> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  await db.insert(account).values({ tenantId: t.id, creditBalance: opening, creditHeld: 0n });
  return t.id;
}

async function accountBalance(tenantId: string): Promise<bigint> {
  const [a] = await db.select().from(account).where(eq(account.tenantId, tenantId));
  if (!a) throw new Error('no account');
  return a.creditBalance;
}

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

describe('/v1/payments', () => {
  it('POST /v1/payments/intents (topup) creates an intent with the frozen credit_amount', async () => {
    const tenantId = await seedTenant('acme');
    const { plaintext: key } = await createApiKey(db, { tenantId });

    const res = await request(server())
      .post('/v1/payments/intents')
      .set('authorization', `Bearer ${key}`)
      .send({ provider: 'stripe', purpose: 'topup', amount_minor: 1000, currency: 'usd' })
      .expect(201);

    expect(res.body.intent_id).toBeTruthy();
    expect(res.body.redirect_url).toBe('https://checkout.example/sess_e2e_123');

    const [intent] = await db
      .select()
      .from(paymentIntent)
      .where(eq(paymentIntent.id, String(res.body.intent_id)));
    expect(intent?.status).toBe('created');
    expect(intent?.amountMinor).toBe(1000n);
    // 1000 cents ($10) × 10_000 µUSD = 10_000_000 µUSD.
    expect(intent?.creditAmount).toBe(10_000_000n);
  });

  it('POST /v1/payments/webhooks/stripe (valid) credits the account by credit_amount, once', async () => {
    const tenantId = await seedTenant('acme', 0n);
    const { plaintext: key } = await createApiKey(db, { tenantId });

    await request(server())
      .post('/v1/payments/intents')
      .set('authorization', `Bearer ${key}`)
      .send({ provider: 'stripe', purpose: 'topup', amount_minor: 1000, currency: 'usd' })
      .expect(201);

    const webhook = await request(server())
      .post('/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .send({ id: EVENT_ID })
      .expect(200);
    expect(webhook.body).toEqual({ status: 'ok', fulfilled: true });

    // Account credited by 1000 cents × 10_000 = 10_000_000 µUSD, one topup row.
    expect(await accountBalance(tenantId)).toBe(10_000_000n);
    const ledger = await db.select().from(ledgerTxn);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe('topup');
    expect(ledger[0]?.creditsDelta).toBe(10_000_000n);

    const [intent] = await db
      .select()
      .from(paymentIntent)
      .where(eq(paymentIntent.providerRef, PROVIDER_REF));
    expect(intent?.status).toBe('succeeded');
  });

  it('duplicate webhook delivery leaves the balance unchanged (idempotent)', async () => {
    const tenantId = await seedTenant('acme', 0n);
    const { plaintext: key } = await createApiKey(db, { tenantId });

    await request(server())
      .post('/v1/payments/intents')
      .set('authorization', `Bearer ${key}`)
      .send({ provider: 'stripe', purpose: 'topup', amount_minor: 1000, currency: 'usd' })
      .expect(201);

    await request(server())
      .post('/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .send({ id: EVENT_ID })
      .expect(200);

    const dup = await request(server())
      .post('/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .send({ id: EVENT_ID })
      .expect(200);
    expect(dup.body).toEqual({ status: 'ok', fulfilled: false });

    // Still credited exactly once; only one event row across both deliveries.
    expect(await accountBalance(tenantId)).toBe(10_000_000n);
    expect(await db.select().from(ledgerTxn)).toHaveLength(1);
    expect(await db.select().from(paymentEvent)).toHaveLength(1);
  });

  it('bad-signature webhook → 401 and no credit', async () => {
    const tenantId = await seedTenant('acme', 0n);
    const { plaintext: key } = await createApiKey(db, { tenantId });

    await request(server())
      .post('/v1/payments/intents')
      .set('authorization', `Bearer ${key}`)
      .send({ provider: 'stripe', purpose: 'topup', amount_minor: 1000, currency: 'usd' })
      .expect(201);

    const res = await request(server())
      .post('/v1/payments/webhooks/stripe')
      .set('content-type', 'application/json')
      .send({ forged: true })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');

    // No credit, no event row, intent still `created`.
    expect(await accountBalance(tenantId)).toBe(0n);
    expect(await db.select().from(ledgerTxn)).toHaveLength(0);
    expect(await db.select().from(paymentEvent)).toHaveLength(0);
    const [intent] = await db
      .select()
      .from(paymentIntent)
      .where(eq(paymentIntent.providerRef, PROVIDER_REF));
    expect(intent?.status).toBe('created');
  });

  it('GET /v1/payments/intents/:id is tenant-scoped (cross-tenant → 404)', async () => {
    const tenantA = await seedTenant('owner');
    const { plaintext: keyA } = await createApiKey(db, { tenantId: tenantA });
    const tenantB = await seedTenant('intruder');
    const { plaintext: keyB } = await createApiKey(db, { tenantId: tenantB });

    const created = await request(server())
      .post('/v1/payments/intents')
      .set('authorization', `Bearer ${keyA}`)
      .send({ provider: 'stripe', purpose: 'topup', amount_minor: 1000, currency: 'usd' })
      .expect(201);
    const intentId = String(created.body.intent_id);

    // Owner reads it.
    const ownerRead = await request(server())
      .get(`/v1/payments/intents/${intentId}`)
      .set('authorization', `Bearer ${keyA}`)
      .expect(200);
    expect(ownerRead.body.id).toBe(intentId);
    expect(ownerRead.body.credit_amount).toBe('10000000');

    // Other tenant gets a 404 (indistinguishable from missing).
    const crossRead = await request(server())
      .get(`/v1/payments/intents/${intentId}`)
      .set('authorization', `Bearer ${keyB}`)
      .expect(404);
    expect(crossRead.body.error.code).toBe('resource_not_found');
  });

  it('GET /admin/payments lists a tenant’s intents (admin-guarded)', async () => {
    const tenantId = await seedTenant('acme');
    const { plaintext: key } = await createApiKey(db, { tenantId });

    await request(server())
      .post('/v1/payments/intents')
      .set('authorization', `Bearer ${key}`)
      .send({ provider: 'stripe', purpose: 'topup', amount_minor: 1000, currency: 'usd' })
      .expect(201);

    const token = await adminToken();

    const res = await request(server())
      .get(`/admin/payments?tenantId=${tenantId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.has_more).toBe(false);
    expect(res.body.data[0].provider).toBe('stripe');
    expect(res.body.data[0].credit_amount).toBe('10000000');

    // No admin token → 401.
    await request(server()).get(`/admin/payments?tenantId=${tenantId}`).expect(401);
  });
});
