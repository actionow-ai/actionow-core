import { createDefaultRegistry } from '@actionow/adapters';
import { createApiKey, createDb, createModel, type Database, schema } from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import { DefaultBreakerStore } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import { FakeBreakerRedis, FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { pgBreakerPersistence, resolveChannelBreakerConfig } from '../src/common/breaker-store.js';
import { ADAPTERS, BREAKER, DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';
import { UnifiedErrorFilter } from '../src/common/unified-error.filter.js';

/**
 * Moderation-relay e2e (`POST /v1/moderations`). Boots a REAL HTTP server and
 * relays onto the `mock-chat` adapter's `moderate`, which flags an input iff it
 * contains the literal "bad" + reports `inputTokens = inputs.length * 4` (INPUT
 * tokens only). The REAL MODEL_RESOLVER resolves the seeded moderation `model`
 * (public + active), the relay prices it via a `model_token` pricebook built from
 * the model's `inputPrice`/`outputPrice` and sets `usageLogModel`, so a `usage_log`
 * row is written and the settle is `model_token`-priced — charged on INPUT tokens
 * ONLY (the `outputPrice` never fires).
 */

/** The seeded moderation resource id (provider `mock-chat`, blocking). */
const MOD_RESOURCE = 'moderation-mock-resource';
/** The seeded public moderation model name callers send in the request body. */
const MODEL_NAME = 'mock-moderation-model';
/** µUSD per 1M input tokens (resale price; $1.25/1M) seeded on the model. */
const INPUT_PRICE = 1_250_000n;
/** µUSD per 1M output tokens — seeded but MUST never contribute to a moderation settle. */
const OUTPUT_PRICE = 10_000_000n;
/** µUSD per 1M tokens denominator. */
const PER_1M = 1_000_000n;
/** The mock-chat moderate input-token count per input string. */
const MOD_TOKENS_PER_INPUT = 4n;

/**
 * Expected settle cost in µUSD (round-half-up), INPUT tokens only, for N inputs:
 * in = N * 4. For N=1 → in=4 → roundHalfUp(4 * 1_250_000 / 1e6) = roundHalfUp(5) = 5.
 */
function expectedCost(inputs: number): bigint {
  const inTokens = BigInt(inputs) * MOD_TOKENS_PER_INPUT;
  return (inTokens * INPUT_PRICE + PER_1M / 2n) / PER_1M;
}

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;
let apiKeyId: string;

/** A no-op queue: moderation runs blocking, never enqueue. */
const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

async function settleRows(jobId: string): Promise<(typeof schema.ledgerTxn.$inferSelect)[]> {
  const rows = await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId));
  return rows.filter((l) => l.type === 'settle');
}

/** The newest succeeded moderation job (newest first). */
async function latestModJob(): Promise<typeof schema.job.$inferSelect | undefined> {
  const jobs = await db.select().from(schema.job).where(eq(schema.job.resourceId, MOD_RESOURCE));
  return jobs
    .filter((j) => j.status === 'succeeded')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pgUri = pg.getConnectionUri();
  db = createDb(pgUri);
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const env: AppEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: pgUri,
    REDIS_URL: 'redis://localhost:6379',
    API_PORT: 0,
    LOG_LEVEL: 'info',
    RATE_LIMIT_TENANT_PER_MIN: 600,
    RATE_LIMIT_RESOURCE_PER_MIN: 600,
    ADMIN_JWT_SECRET: 'moderation-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
  };

  const adapters = createDefaultRegistry();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ADAPTERS)
    .useValue(adapters)
    .overrideProvider(JOB_QUEUE)
    .useValue(noopQueue)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(BREAKER)
    .useValue(
      new DefaultBreakerStore({
        redis: new FakeBreakerRedis(),
        persistence: pgBreakerPersistence(db),
        configFor: (channelId: string) => resolveChannelBreakerConfig(db, channelId),
      }),
    )
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  const [t] = await db.insert(schema.tenant).values({ name: 'moderation-tenant' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;
  apiKeyId = key.id;

  await db.insert(schema.resource).values({
    id: MOD_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'moderation',
    providerType: 'mock-chat',
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: MOD_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });
  // A DECOY DB pricebook priced DIFFERENTLY (999/999): the relay ignores the DB
  // pricebook and prices off the model catalog, so every settle must land at the
  // input-token-only expected cost.
  await db.insert(schema.pricebookEntry).values({
    resourceId: MOD_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing: 'post',
    spec: { method: 'model_token', inputPrice: 999, outputPrice: 999 },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: MOD_RESOURCE,
    providerType: 'mock-chat',
    weight: 1,
    status: 'active',
  });

  await createModel(db, {
    name: MODEL_NAME,
    resourceId: MOD_RESOURCE,
    display: 'Mock Moderation Model',
    modality: 'moderation',
    capabilities: {},
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });
}, 120_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('OpenAI moderations (/v1/moderations)', () => {
  it('string input → 200 results shape + verdict, settle-once on INPUT tokens, usage_log', async () => {
    const res = await fetch(`${baseUrl}/v1/moderations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: 'a bad thing' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-actionow-channel')).toBe('mock-chat');
    const body = asRecord(await res.json());
    expect(typeof body.id).toBe('string');
    expect((body.id as string).startsWith('modr-')).toBe(true);
    expect(body.model).toBe(MODEL_NAME);
    const results = body.results as Record<string, unknown>[];
    expect(results).toHaveLength(1);
    // "bad" present → flagged true, with category booleans + scores.
    expect(asRecord(results[0]).flagged).toBe(true);
    expect(asRecord(asRecord(results[0]).categories).violence).toBe(true);
    expect(asRecord(asRecord(results[0]).category_scores).violence).toBe(0.99);

    const job = await latestModJob();
    expect(job).toBeDefined();
    const jobId = job?.id ?? '';
    const rows = await settleRows(jobId);
    // Settles exactly ONE ledger row, charged on INPUT tokens only (NOT 999/999,
    // NOT including outputPrice).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-expectedCost(1));
    expect(job?.costCredits).toBe(expectedCost(1));

    // A usage_log row was mirrored: input tokens only, output 0.
    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    const log = logs.find((l) => l.model === MODEL_NAME);
    expect(log).toBeDefined();
    expect(log?.inputTokens).toBe(Number(MOD_TOKENS_PER_INPUT));
    expect(log?.outputTokens).toBe(0);
    expect(log?.cost).toBe(expectedCost(1));
    expect(log?.apiKeyId).toBe(apiKeyId);
  });

  it('string[] batch input → one verdict per input, settle on the summed input tokens', async () => {
    const res = await fetch(`${baseUrl}/v1/moderations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: ['fine text', 'a bad one'] }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const results = body.results as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    expect(asRecord(results[0]).flagged).toBe(false);
    expect(asRecord(results[1]).flagged).toBe(true);

    const job = await latestModJob();
    const rows = await settleRows(job?.id ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-expectedCost(2));
    expect(job?.costCredits).toBe(expectedCost(2));
  });

  it('unknown model → 404 resource_not_found', async () => {
    const res = await fetch(`${baseUrl}/v1/moderations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-moderation-model', input: 'hi' }),
    });
    expect(res.status).toBe(404);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('resource_not_found');
  });

  it('missing api key → 401 unauthorized', async () => {
    const res = await fetch(`${baseUrl}/v1/moderations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('invalid body (no input) → 400 invalid_input', async () => {
    const res = await fetch(`${baseUrl}/v1/moderations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME }),
    });
    expect(res.status).toBe(400);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('invalid_input');
  });

  it('insufficient credits → 402 insufficient_credits', async () => {
    const [poorTenant] = await db.insert(schema.tenant).values({ name: 'broke-mod' }).returning();
    if (!poorTenant) throw new Error('no tenant');
    await db
      .insert(schema.account)
      .values({ tenantId: poorTenant.id, creditBalance: 0n, creditHeld: 0n });
    const poorKey = await createApiKey(db, { tenantId: poorTenant.id });

    const res = await fetch(`${baseUrl}/v1/moderations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${poorKey.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: 'a bad thing' }),
    });
    expect(res.status).toBe(402);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('insufficient_credits');
  });

  it('replays the original moderation job on a repeated Idempotency-Key', async () => {
    const idemKey = 'moderation-idem-key-1';
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/v1/moderations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({ model: MODEL_NAME, input: 'idem text' }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = asRecord(await first.json());

    const second = await send();
    expect(second.status).toBe(200);
    const secondBody = asRecord(await second.json());

    expect(secondBody.results).toEqual(firstBody.results);

    // Exactly ONE job carries this key, settled exactly once → no double charge.
    const jobs = await db.select().from(schema.job).where(eq(schema.job.idempotencyKey, idemKey));
    expect(jobs).toHaveLength(1);
    expect(await settleRows(jobs[0]?.id ?? '')).toHaveLength(1);
  });
});
