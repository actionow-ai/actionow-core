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
 * Embeddings-relay e2e (`POST /v1/embeddings`). Boots a REAL HTTP server and
 * relays onto the `mock-chat` adapter's `embed`, which returns a fixed vector
 * `[0.1,0.2,0.3]` per input string + `inputTokens = inputs.length * 4` (INPUT
 * tokens only). The REAL MODEL_RESOLVER resolves the seeded embeddings `model`
 * (public + active), the relay prices it via a `model_token` pricebook built
 * from the model's `inputPrice`/`outputPrice` and sets `usageLogModel`, so a
 * `usage_log` row is written and the settle is `model_token`-priced — charged on
 * INPUT tokens ONLY (the `outputPrice` never fires, since the usage vector
 * carries no `output_tokens`).
 */

/** The seeded embeddings resource id (provider `mock-chat`, blocking). */
const EMBED_RESOURCE = 'embed-mock-resource';
/** The seeded public embeddings model name callers send in the request body. */
const MODEL_NAME = 'mock-embed-model';
/** µUSD per 1M input tokens (resale price; $1.25/1M) seeded on the model. */
const INPUT_PRICE = 1_250_000n;
/** µUSD per 1M output tokens — seeded but MUST never contribute to an embeddings settle. */
const OUTPUT_PRICE = 10_000_000n;
/** µUSD per 1M tokens denominator. */
const PER_1M = 1_000_000n;
/** The mock-chat embed input-token count per input string. */
const EMBED_TOKENS_PER_INPUT = 4n;
/** The mock's fixed embedding vector length. */
const VECTOR_LEN = 3;

/**
 * Expected single-input settle cost in µUSD (round-half-up), INPUT tokens only:
 *   roundHalfUp(in*inputPrice / 1e6)
 * = roundHalfUp(4*1_250_000 / 1e6) = roundHalfUp(5_000_000/1e6) = roundHalfUp(5) = 5.
 */
const EXPECTED_COST_ONE = (EMBED_TOKENS_PER_INPUT * INPUT_PRICE + PER_1M / 2n) / PER_1M;
/** Expected settle for a 2-string batch input (8 input tokens). */
const EXPECTED_COST_TWO = (2n * EMBED_TOKENS_PER_INPUT * INPUT_PRICE + PER_1M / 2n) / PER_1M;

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;
let apiKeyId: string;

/** A no-op queue: embeddings run blocking, never enqueue. */
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

/** The newest succeeded embeddings job (newest first). */
async function latestEmbedJob(): Promise<typeof schema.job.$inferSelect | undefined> {
  const jobs = await db.select().from(schema.job).where(eq(schema.job.resourceId, EMBED_RESOURCE));
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
    ADMIN_JWT_SECRET: 'embed-admin-secret',
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

  const [t] = await db.insert(schema.tenant).values({ name: 'embed-tenant' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;
  apiKeyId = key.id;

  // Embeddings resource: provider `mock-chat`, blocking, io_schema with NO
  // required inputs (the `__ir` passthrough is stripped before validation).
  await db.insert(schema.resource).values({
    id: EMBED_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'embedding',
    providerType: 'mock-chat',
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: EMBED_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });
  // A DECOY DB pricebook priced DIFFERENTLY (999/999): the relay ignores the DB
  // pricebook and prices off the model catalog, so every settle must land at the
  // input-token-only EXPECTED_COST.
  await db.insert(schema.pricebookEntry).values({
    resourceId: EMBED_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing: 'post',
    spec: { method: 'model_token', inputPrice: 999, outputPrice: 999 },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: EMBED_RESOURCE,
    providerType: 'mock-chat',
    weight: 1,
    status: 'active',
  });

  // A real, public, active embeddings model → the REAL MODEL_RESOLVER returns it.
  await createModel(db, {
    name: MODEL_NAME,
    resourceId: EMBED_RESOURCE,
    display: 'Mock Embeddings Model',
    modality: 'embedding',
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

describe('OpenAI embeddings (/v1/embeddings)', () => {
  it('string input → 200 list shape + a vector, settle-once on INPUT tokens, usage_log', async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: 'hello world' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-actionow-channel')).toBe('mock-chat');
    const body = asRecord(await res.json());
    expect(body.object).toBe('list');
    expect(body.model).toBe(MODEL_NAME);
    const data = body.data as Record<string, unknown>[];
    expect(data).toHaveLength(1);
    expect(asRecord(data[0]).object).toBe('embedding');
    expect(asRecord(data[0]).index).toBe(0);
    const vector = asRecord(data[0]).embedding as number[];
    expect(Array.isArray(vector)).toBe(true);
    expect(vector).toHaveLength(VECTOR_LEN);
    // usage: input-token only — total_tokens === prompt_tokens.
    const usage = asRecord(body.usage);
    expect(usage.prompt_tokens).toBe(Number(EMBED_TOKENS_PER_INPUT));
    expect(usage.total_tokens).toBe(Number(EMBED_TOKENS_PER_INPUT));

    const job = await latestEmbedJob();
    expect(job).toBeDefined();
    const jobId = job?.id ?? '';
    const rows = await settleRows(jobId);
    // Settles exactly ONE ledger row, charged on INPUT tokens only (NOT 999/999,
    // NOT including outputPrice).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-EXPECTED_COST_ONE);
    expect(job?.costCredits).toBe(EXPECTED_COST_ONE);

    // A usage_log row was mirrored (usageLogModel set): input tokens only, output 0.
    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    const log = logs.find((l) => l.model === MODEL_NAME);
    expect(log).toBeDefined();
    expect(log?.inputTokens).toBe(Number(EMBED_TOKENS_PER_INPUT));
    expect(log?.outputTokens).toBe(0);
    expect(log?.cost).toBe(EXPECTED_COST_ONE);
    expect(log?.apiKeyId).toBe(apiKeyId);
  });

  it('string[] batch input → one vector per input, settle on the summed input tokens', async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: ['alpha', 'beta'] }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const data = body.data as Record<string, unknown>[];
    expect(data).toHaveLength(2);
    expect(asRecord(data[0]).index).toBe(0);
    expect(asRecord(data[1]).index).toBe(1);
    expect(asRecord(body.usage).prompt_tokens).toBe(Number(2n * EMBED_TOKENS_PER_INPUT));

    const job = await latestEmbedJob();
    const rows = await settleRows(job?.id ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-EXPECTED_COST_TWO);
    expect(job?.costCredits).toBe(EXPECTED_COST_TWO);
  });

  it('unknown model → 404 resource_not_found', async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-embed-model', input: 'hi' }),
    });
    expect(res.status).toBe(404);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('resource_not_found');
  });

  it('missing api key → 401 unauthorized', async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('invalid body (no input) → 400 invalid_input', async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME }),
    });
    expect(res.status).toBe(400);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('invalid_input');
  });

  it('insufficient credits → 402 insufficient_credits', async () => {
    // A separate tenant with a ZERO balance: the hold fails before the upstream call.
    const [poorTenant] = await db.insert(schema.tenant).values({ name: 'broke' }).returning();
    if (!poorTenant) throw new Error('no tenant');
    await db
      .insert(schema.account)
      .values({ tenantId: poorTenant.id, creditBalance: 0n, creditHeld: 0n });
    const poorKey = await createApiKey(db, { tenantId: poorTenant.id });

    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${poorKey.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, input: 'hello world' }),
    });
    expect(res.status).toBe(402);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('insufficient_credits');
  });

  it('replays the original embeddings job on a repeated Idempotency-Key', async () => {
    const idemKey = 'embed-idem-key-1';
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify({ model: MODEL_NAME, input: 'idem' }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = asRecord(await first.json());

    const second = await send();
    expect(second.status).toBe(200);
    const secondBody = asRecord(await second.json());

    expect(secondBody.data).toEqual(firstBody.data);
    expect(secondBody.usage).toEqual(firstBody.usage);

    // Exactly ONE job carries this key, settled exactly once → no double charge.
    const jobs = await db.select().from(schema.job).where(eq(schema.job.idempotencyKey, idemKey));
    expect(jobs).toHaveLength(1);
    expect(await settleRows(jobs[0]?.id ?? '')).toHaveLength(1);
  });
});
