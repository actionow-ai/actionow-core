import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { PaymentService } from '@actionow/engine';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, JOB_QUEUE, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const { paymentIntent } = schema;

const CREDIT_RATE = 10_000n; // µUSD per cent (1 cent → 10_000 µUSD; $1 → 1e6 µUSD)
const PROVIDER_REF = 'sess_console_e2e';
const EVENT_ID = 'evt_console_e2e';
const ADMIN_SECRET = 'console-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('console path must not enqueue')),
};

/**
 * The fake provider injected for the e2e: `createIntent` returns a canned
 * providerRef/redirect (no real Stripe network), so a self-serve console topup
 * needs no Stripe creds. `verifyWebhook` is unused by the console plane but kept
 * for parity with the payments harness.
 */
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
      // The whole suite shares one per-IP auth-throttle bucket (fake limiter, fixed
      // window, all requests from 127.0.0.1); raise it so registering test users
      // across the suite never trips the 10/min default.
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
  await resetDb(
    () =>
      client`TRUNCATE TABLE file_object, api_key, ledger_txn, payment_intent, payment_event, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/**
 * Self-register a brand-new user via `/auth/register` (provisions a tenant +
 * account) and return its USER JWT — the bearer the {@link ConsoleGuard} accepts.
 */
async function registerUser(email: string, password = 'sup3rSecret'): Promise<string> {
  const res = await request(server()).post('/auth/register').send({ email, password }).expect(200);
  return res.body.token as string;
}

describe('/console', () => {
  it('a self-registered user mints its OWN tenant key and calls /v1 with it', async () => {
    const token = await registerUser('owner@example.com');

    // Mint a key for the caller's own tenant — plaintext returned ONCE.
    const minted = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect(minted.body.id).toBeTypeOf('string');
    expect(minted.body.plaintext).toBeTypeOf('string');
    const key = minted.body.plaintext as string;

    // The audited gap is CLOSED: the self-minted tenant key drives the /v1 data
    // plane (ApiKeyGuard) without any admin ever issuing a key.
    const jobs = await request(server())
      .get('/v1/jobs')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(Array.isArray(jobs.body.data)).toBe(true);

    // Listing returns the key WITHOUT a hash (the plaintext is unrecoverable).
    const listed = await request(server())
      .get('/console/api-keys')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.has_more).toBe(false);
    expect(listed.body.data[0].id).toBe(minted.body.id);
    expect(listed.body.data[0].status).toBe('active');
    expect(listed.body.data[0]).not.toHaveProperty('hash');

    // Rotate mints a fresh plaintext (and a new id) and disables the old key.
    const rotated = await request(server())
      .post(`/console/api-keys/${String(minted.body.id)}/rotate`)
      .set('authorization', `Bearer ${token}`)
      .expect(201);
    expect(rotated.body.plaintext).toBeTypeOf('string');
    expect(rotated.body.plaintext).not.toBe(key);
    expect(rotated.body.id).not.toBe(minted.body.id);

    // Disable the rotated key.
    const disabled = await request(server())
      .delete(`/console/api-keys/${String(rotated.body.id)}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(disabled.body).toEqual({ id: rotated.body.id, status: 'disabled' });
  });

  it('unauthenticated /console/api-keys → 401 unauthorized', async () => {
    const res = await request(server()).get('/console/api-keys').expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('cross-tenant disable is a 404 (a tenant cannot touch another tenant key)', async () => {
    const ownerToken = await registerUser('a@example.com');
    const intruderToken = await registerUser('b@example.com');

    const owned = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(201);

    // The intruder cannot disable the owner's key — indistinguishable from missing.
    const res = await request(server())
      .delete(`/console/api-keys/${String(owned.body.id)}`)
      .set('authorization', `Bearer ${intruderToken}`)
      .expect(404);
    expect(res.body.error.code).toBe('resource_not_found');
  });

  it('self-topup → 201 and writes a payment_intent with purpose=topup', async () => {
    const token = await registerUser('topup@example.com');

    const res = await request(server())
      .post('/console/payments/intents')
      .set('authorization', `Bearer ${token}`)
      .send({ provider: 'stripe', amount_minor: 1000, currency: 'usd' })
      .expect(201);
    expect(res.body.intent_id).toBeTypeOf('string');
    expect(res.body.redirect_url).toBe('https://checkout.example/console');

    const [intent] = await db
      .select()
      .from(paymentIntent)
      .where(eq(paymentIntent.id, String(res.body.intent_id)));
    expect(intent?.purpose).toBe('topup');
    expect(intent?.status).toBe('created');
    expect(intent?.amountMinor).toBe(1000n);
    // 1000 cents ($10) × 10_000 µUSD = 10_000_000 µUSD.
    expect(intent?.creditAmount).toBe(10_000_000n);

    // The status endpoint returns the intent (for post-topup polling); another
    // tenant cannot read it (cross-tenant → 404), and it needs a token.
    const id = String(res.body.intent_id);
    await request(server()).get(`/console/payments/intents/${id}`).expect(401);
    const status = await request(server())
      .get(`/console/payments/intents/${id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(status.body.id).toBe(id);
    expect(status.body.status).toBe('created');

    const other = await registerUser('topup-other@example.com');
    await request(server())
      .get(`/console/payments/intents/${id}`)
      .set('authorization', `Bearer ${other}`)
      .expect(404);
  });

  it('usage returns tenant-scoped jobs + ledger and models is an array', async () => {
    const token = await registerUser('usage@example.com');

    const usage = await request(server())
      .get('/console/usage')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    // /console/usage returns TWO envelopes: { jobs: <envelope>, ledger: <envelope> }.
    expect(Array.isArray(usage.body.jobs.data)).toBe(true);
    expect(usage.body.jobs).toHaveProperty('next_cursor');
    expect(usage.body.jobs).toHaveProperty('has_more');
    expect(Array.isArray(usage.body.ledger.data)).toBe(true);
    expect(usage.body.ledger).toHaveProperty('next_cursor');

    const models = await request(server())
      .get('/console/models')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(models.body.data)).toBe(true);
    expect(models.body.has_more).toBe(false);
  });

  it('analytics/usage + usage-log are tenant-scoped (401 without a token); analytics rejects groupBy=tenant', async () => {
    const token = await registerUser('usage2@example.com');

    // Tenant-scoped: the ConsoleGuard rejects an anonymous caller.
    await request(server()).get('/console/analytics/usage?groupBy=model').expect(401);
    await request(server()).get('/console/usage-log').expect(401);

    // Rollups: an array (empty for a fresh tenant), tenant locked by the guard.
    const analytics = await request(server())
      .get('/console/analytics/usage?groupBy=model')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(analytics.body)).toBe(true);

    // The `tenant` groupBy is admin-only — a tenant only has itself → 400.
    await request(server())
      .get('/console/analytics/usage?groupBy=tenant')
      .set('authorization', `Bearer ${token}`)
      .expect(400);

    // Per-call usage log: a keyset envelope.
    const log = await request(server())
      .get('/console/usage-log?limit=5')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(log.body.data)).toBe(true);
    expect(log.body).toHaveProperty('next_cursor');
    expect(log.body).toHaveProperty('has_more');
  });

  it('balance returns the tenant’s credit balance + held as µ-strings (401 without a token)', async () => {
    const token = await registerUser('balance@example.com');
    await request(server()).get('/console/balance').expect(401);

    const bal = await request(server())
      .get('/console/balance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(bal.body.balance).toBe('0'); // fresh tenant
    expect(bal.body.held).toBe('0');
  });

  it('payments history lists the tenant’s own intents (401 without a token)', async () => {
    const token = await registerUser('payhist@example.com');
    await request(server()).get('/console/payments').expect(401);

    // A self-topup writes an intent → it shows in the history.
    await request(server())
      .post('/console/payments/intents')
      .set('authorization', `Bearer ${token}`)
      .send({ provider: 'stripe', amount_minor: 2500, currency: 'usd' })
      .expect(201);

    const hist = await request(server())
      .get('/console/payments?limit=10')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0].provider).toBe('stripe');
    expect(hist.body.data[0].amount_minor).toBe('2500');
    expect(hist.body.data[0].purpose).toBe('topup');
  });

  it('me returns the profile (no hash); settings changes the password after verifying the current one', async () => {
    const token = await registerUser('settings@example.com', 'oldPassw0rd');
    await request(server()).get('/console/me').expect(401);

    const me = await request(server())
      .get('/console/me')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.email).toBe('settings@example.com');
    expect(me.body.role).toBe('user');
    expect(me.body).not.toHaveProperty('password_hash');

    // Wrong current password → 400; too-short new → 400.
    await request(server())
      .patch('/console/settings')
      .set('authorization', `Bearer ${token}`)
      .send({ currentPassword: 'WRONG', newPassword: 'newPassw0rd' })
      .expect(400);
    await request(server())
      .patch('/console/settings')
      .set('authorization', `Bearer ${token}`)
      .send({ currentPassword: 'oldPassw0rd', newPassword: 'short' })
      .expect(400);

    // Correct current → 200, and the new password then authenticates.
    await request(server())
      .patch('/console/settings')
      .set('authorization', `Bearer ${token}`)
      .send({ currentPassword: 'oldPassw0rd', newPassword: 'newPassw0rd' })
      .expect(200);
    await request(server())
      .post('/auth/login')
      .send({ email: 'settings@example.com', password: 'newPassw0rd' })
      .expect(200);
  });

  it('files: the gallery lists READY tenant media with a viewable url, filters by kind, and is tenant-scoped (401 without a token)', async () => {
    const token = await registerUser('gallery@example.com');
    const otherToken = await registerUser('gallery-other@example.com');
    await request(server()).get('/console/files').expect(401);

    const me = await request(server())
      .get('/console/me')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const otherMe = await request(server())
      .get('/console/me')
      .set('authorization', `Bearer ${otherToken}`)
      .expect(200);
    const tenantId = me.body.tenant_id as string;
    const otherTenantId = otherMe.body.tenant_id as string;

    // Seed: a ready image + a ready video (the gallery), a pending upload (excluded),
    // and a ready file owned by ANOTHER tenant (must never leak).
    await db.insert(schema.fileObject).values([
      {
        tenantId,
        provider: 'r2',
        bucket: 'actionow',
        key: `${tenantId}/img.png`,
        status: 'ready',
        contentType: 'image/png',
        size: 100,
      },
      {
        tenantId,
        provider: 'r2',
        bucket: 'actionow',
        key: `${tenantId}/clip.mp4`,
        status: 'ready',
        contentType: 'video/mp4',
        size: 200,
      },
      {
        tenantId,
        provider: 'r2',
        bucket: 'actionow',
        key: `${tenantId}/pending.png`,
        status: 'pending',
        contentType: 'image/png',
      },
      {
        tenantId: otherTenantId,
        provider: 'r2',
        bucket: 'actionow',
        key: `${otherTenantId}/secret.png`,
        status: 'ready',
        contentType: 'image/png',
        size: 50,
      },
    ]);

    // All ready files of the CALLER's tenant, with a public-base url; pending + other-tenant excluded.
    const all = await request(server())
      .get('/console/files')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(all.body.data).toHaveLength(2);
    const urls = (all.body.data as { url: string }[]).map((f) => f.url);
    expect(urls).toContain(`https://asset.example/${tenantId}/img.png`);
    expect(urls).toContain(`https://asset.example/${tenantId}/clip.mp4`);
    expect(urls.some((u) => u.includes('secret'))).toBe(false);
    expect(all.body).toHaveProperty('has_more', false);
    expect(all.body).toHaveProperty('next_cursor');

    // kind=video narrows to the clip.
    const vids = await request(server())
      .get('/console/files?kind=video')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(vids.body.data).toHaveLength(1);
    expect(vids.body.data[0].content_type).toBe('video/mp4');
    expect(vids.body.data[0].status).toBe('ready');
  });
});
