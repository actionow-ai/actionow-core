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
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, JOB_QUEUE, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';
import { MODELS_PORT } from '../src/console/models.port.js';

const CREDIT_RATE = 1000n;
const PROVIDER_REF = 'sess_console_models_e2e';
const EVENT_ID = 'evt_console_models_e2e';
const ADMIN_SECRET = 'console-models-e2e-secret';

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

/**
 * A NON-EMPTY ModelsPort standing in for Track C's real `listVisibleModels`.
 * Overriding the seam here proves that when Track C lands and binds the real
 * port, `GET /console/models` returns its output verbatim — no rename, no
 * adapter, no behavior change in Track B.
 */
const oneModelPort = {
  listVisibleModels: () =>
    Promise.resolve([
      {
        name: 'gpt-4o',
        display: 'GPT-4o',
        modality: 'chat',
        capabilities: { tools: true },
        visibility: 'public',
      },
    ]),
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
    .overrideProvider(MODELS_PORT)
    .useValue(oneModelPort)
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
      CREDIT_RATE: 1000,
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
  await client`TRUNCATE TABLE api_key, ledger_txn, payment_intent, payment_event, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
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

describe('GET /console/models honors the bound ModelsPort (Track C seam)', () => {
  it('returns the tenant-visible models from the port', async () => {
    const token = await registerUser('models@example.com');
    const res = await request(app.getHttpServer())
      .get('/console/models')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.has_more).toBe(false);
    expect(res.body.data[0]).toMatchObject({ name: 'gpt-4o', visibility: 'public' });
  });
});
