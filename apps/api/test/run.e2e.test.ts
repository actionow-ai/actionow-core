import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterRegistry } from '@actionow/adapters';
import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';
import type { Job } from '@actionow/db';
import { schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
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
import { ADAPTERS, DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';

const {
  account,
  ledgerTxn,
  modifier,
  pricebookEntry,
  resource,
  resourceVersion,
  tenant,
  upstreamChannel,
} = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let tenantId: string;

/** A no-op queue: the blocking path never enqueues, so this is never called. */
const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('blocking path must not enqueue')),
};

/** A stubbed blocking LLM adapter — no network; returns fixed text + usage. */
const fakeLlm: ProviderAdapter = {
  providerType: 'fake-llm',
  submit(input: SubmitInput): Promise<SubmitResult> {
    return Promise.resolve({
      kind: 'sync',
      output: { text: `echo: ${String(input.inputs.prompt)}` },
      usage: { tokens: 300 },
    });
  },
  extractUsage(): UsageVector {
    return {};
  },
  mapError(): UnifiedError {
    return { code: 'upstream_error', message: 'fake', retryable: false };
  },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const adapters = new AdapterRegistry();
  adapters.register(fakeLlm);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ADAPTERS)
    .useValue(adapters)
    .overrideProvider(JOB_QUEUE)
    .useValue(noopQueue)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'test',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      // Track B Task 5: the `x-tenant-id` dev fallback now requires an explicit
      // opt-in even outside production. This suite drives `/v1/run` via the
      // header without an API key, so it must enable the gate.
      ALLOW_DEV_TENANT_HEADER: true,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
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

interface Seed {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

/** Seed an openai-style blocking resource with a post/unit pricebook + channel. */
async function seed(balance: bigint): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const resourceId = 'openai-gpt';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'fake-llm',
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(resourceVersion).values({
    resourceId,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string' }],
    },
  });
  await db.insert(pricebookEntry).values({
    resourceId,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
    active: true,
  });
  await db.insert(upstreamChannel).values({
    resourceId,
    providerType: 'fake-llm',
    weight: 1,
    status: 'active',
  });
  return { tenantId: t.id, accountId: a.id, resourceId };
}

afterEach(async () => {
  await client`TRUNCATE TABLE webhook_outbox, ledger_txn, idempotency_key, job, pricebook_entry, modifier, upstream_channel, resource_version, resource, account, tenant RESTART IDENTITY CASCADE`;
});

describe('POST /v1/run/:resourceId (blocking)', () => {
  it('returns output+cost, settles the ledger, and the job is fetchable', async () => {
    const s = await seed(1_000_000n);
    tenantId = s.tenantId;

    const res = await request(app.getHttpServer())
      .post(`/v1/run/${s.resourceId}`)
      .set('x-tenant-id', tenantId)
      // estimated_usage sizes the post-method hold (1000 tokens upper bound)
      .send({ inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } })
      .expect(200);

    expect(res.body.status).toBe('succeeded');
    expect(res.body.output).toEqual({ text: 'echo: hi' });
    expect(res.body.usage).toEqual({ tokens: 300 });
    // cost is a decimal string (bigint µcredits, never a float)
    expect(res.body.cost).toEqual({ credits: '300' });
    const jobId = res.body.job_id as string;

    // a settle ledger row exists with the final cost
    const settleRows = (await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, jobId))).filter(
      (l) => l.type === 'settle',
    );
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(-300n);

    // balance debited by final cost, hold released
    const [acct] = await db.select().from(account).where(eq(account.id, s.accountId));
    expect(acct?.creditBalance).toBe(999_700n);
    expect(acct?.creditHeld).toBe(0n);

    // GET /v1/jobs/:id returns the settled job
    const got = await request(app.getHttpServer())
      .get(`/v1/jobs/${jobId}`)
      .set('x-tenant-id', tenantId)
      .expect(200);
    expect(got.body.job_id).toBe(jobId);
    expect(got.body.status).toBe('succeeded');
    expect(got.body.cost).toEqual({ credits: '300' });
  });

  it('returns a 402 insufficient_credits envelope when the balance is too low', async () => {
    const s = await seed(100n); // below the 1000-token hold
    tenantId = s.tenantId;

    const res = await request(app.getHttpServer())
      .post(`/v1/run/${s.resourceId}`)
      .set('x-tenant-id', tenantId)
      .send({ inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } })
      .expect(402);

    expect(res.body).toEqual({
      error: { code: 'insufficient_credits', message: expect.any(String), retryable: false },
    });

    // no job created
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(0);
  });

  it('applies an in-scope modifier and ignores an out-of-scope one (§9.2)', async () => {
    const s = await seed(1_000_000n);
    tenantId = s.tenantId;

    // In scope for (tenantId, openai-gpt): a 10%-off tenant modifier.
    await db.insert(modifier).values({
      scope: `tenant:${s.tenantId}`,
      op: 'percent_off',
      value: 10n,
      priority: 0,
      active: true,
    });
    // Out of scope: a 50%-off modifier scoped to a DIFFERENT tenant. If
    // RunService used the unfiltered list this would slash the cost further;
    // listApplicableModifiers must exclude it.
    await db.insert(modifier).values({
      scope: 'tenant:00000000-0000-0000-0000-000000000000',
      op: 'percent_off',
      value: 50n,
      priority: 0,
      active: true,
    });

    const res = await request(app.getHttpServer())
      .post(`/v1/run/${s.resourceId}`)
      .set('x-tenant-id', tenantId)
      .send({ inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } })
      .expect(200);

    // base 300 µcredits − 10% = 270 (the out-of-scope 50%-off did NOT fire).
    expect(res.body.cost).toEqual({ credits: '270' });

    // the settle ledger row records exactly ONE applied modifier, with its
    // µcredit before/after serialized as decimal strings (JSON-safe).
    const jobId = res.body.job_id as string;
    const [settleRow] = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, jobId))
    ).filter((l) => l.type === 'settle');
    const applied = settleRow?.modifiersApplied as { before: string; after: string }[];
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ before: '300', after: '270' });
  });

  it('returns 404 resource_not_found for an unknown resource', async () => {
    const s = await seed(1_000_000n);
    tenantId = s.tenantId;

    const res = await request(app.getHttpServer())
      .post('/v1/run/does-not-exist')
      .set('x-tenant-id', tenantId)
      .send({ inputs: { prompt: 'hi' } })
      .expect(404);

    expect(res.body.error.code).toBe('resource_not_found');
  });
});

describe('POST /v1/jobs/:id/cancel', () => {
  it('cancels a queued job and releases its hold', async () => {
    const s = await seed(1_000_000n);
    tenantId = s.tenantId;

    // Insert a queued job directly with a hold (simulating an async-queued job)
    await client`UPDATE account SET credit_held = 1000 WHERE id = ${s.accountId}`;
    const [queued] = (await db
      .insert(schema.job)
      .values({
        tenantId: s.tenantId,
        resourceId: s.resourceId,
        resourceVersion: 1,
        status: 'queued',
        execMode: 'async-poll',
        inputs: { prompt: 'hi' },
        quotedCredits: 1000n,
      })
      .returning()) as Job[];
    if (!queued) throw new Error('job insert returned no row');

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${queued.id}/cancel`)
      .set('x-tenant-id', tenantId)
      .expect(200);

    expect(res.body.status).toBe('canceled');

    // hold released
    const [acct] = await db.select().from(account).where(eq(account.id, s.accountId));
    expect(acct?.creditHeld).toBe(0n);
  });
});
