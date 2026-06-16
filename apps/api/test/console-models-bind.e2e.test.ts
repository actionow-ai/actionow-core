import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { createModel, createResource, schema } from '@actionow/db';
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

const { user } = schema;

const CREDIT_RATE = 1000n;
const PROVIDER_REF = 'sess_console_models_bind_e2e';
const EVENT_ID = 'evt_console_models_bind_e2e';
const ADMIN_SECRET = 'console-models-bind-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

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

  // NOTE: MODELS_PORT is NOT overridden — this exercises the real port the
  // console module binds over `listVisibleModels(DB, tenantId)` (Track C seam).
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
  await client`TRUNCATE TABLE model_grant, model, resource_version, resource, api_key, ledger_txn, payment_intent, payment_event, job, account, tenant, "user" RESTART IDENTITY CASCADE`;
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/** Self-register a user (provisions a tenant + account) and return its JWT. */
async function registerUser(email: string, password = 'sup3rSecret'): Promise<string> {
  const res = await request(server()).post('/auth/register').send({ email, password }).expect(200);
  return res.body.token as string;
}

/** Read the tenant id of a registered user by email. */
async function tenantOf(email: string): Promise<string> {
  const [row] = await db
    .select({ tenantId: user.tenantId })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  if (!row?.tenantId) throw new Error(`no tenant for ${email}`);
  return row.tenantId;
}

describe('GET /console/models over the real bound ModelsPort (Track C seam)', () => {
  it('returns a created public model for the caller tenant', async () => {
    const email = 'bind@example.com';
    const token = await registerUser(email);
    const tenantId = await tenantOf(email);

    // Create a chat resource + a public model in the caller's own tenant.
    await createResource(db, {
      id: 'gpt4o-res',
      tenantId,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
      version: 1,
    });
    await createModel(db, {
      name: 'gpt-4o',
      resourceId: 'gpt4o-res',
      display: 'GPT-4o',
      visibility: 'public',
      capabilities: { tools: true },
    });

    const res = await request(server())
      .get('/console/models')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: 'gpt-4o',
      display: 'GPT-4o',
      modality: 'chat',
      visibility: 'public',
    });
    expect(res.body[0].capabilities).toEqual({ tools: true });
  });
});
