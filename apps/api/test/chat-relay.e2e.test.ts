import { createDefaultRegistry } from '@actionow/adapters';
import {
  createApiKey,
  createDb,
  createModel,
  createSubject,
  type Database,
  schema,
} from '@actionow/db';
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
 * Track A12 chat-relay e2e. Boots a REAL HTTP server (`app.listen(0)`) so the
 * SSE responses genuinely stream over the wire (read via `fetch` chunked body)
 * and the disconnect-settles-once property is exercised by aborting the fetch
 * mid-stream — mirroring `stream-callbacks.e2e.test.ts`.
 *
 * The `mock-chat` adapter (registered in the default registry) returns
 * deterministic IR: `chat` → assistant `'hello'`, usage `{inputTokens:10,
 * outputTokens:5}`; `streamChat` → message_start → 'hel' → 'lo' → usage → stop
 * → done. The REAL `MODEL_RESOLVER` resolves the seeded `model` row (public +
 * active), and the relay prices the chat resource via a `model_token` pricebook
 * built from the model's `inputPrice`/`outputPrice` and sets `usageLogModel`,
 * so a `usage_log` row is written and the settle is `model_token`-priced.
 */

/** The seeded chat resource id (provider `mock-chat`, stream + blocking). */
const CHAT_RESOURCE = 'chat-mock-resource';
/** The seeded public model name callers send in the request body / URL. */
const MODEL_NAME = 'mock-model';
/** A capability-restricted public model (no tools/vision/audio/json). */
const NO_CAPS_MODEL = 'mock-model-no-caps';
/** µUSD per 1M input tokens (resale price; $1.25/1M) seeded on the model. */
const INPUT_PRICE = 1_250_000n;
/** µUSD per 1M output tokens (resale price; $10/1M) seeded on the model. */
const OUTPUT_PRICE = 10_000_000n;
/** µUSD per 1M tokens denominator (Track 1). */
const PER_1M = 1_000_000n;
/** The mock-chat fixed usage (camelCase IR). */
const MOCK_INPUT_TOKENS = 10n;
const MOCK_OUTPUT_TOKENS = 5n;
/**
 * Expected model_token settle cost in µUSD (round-half-up):
 *   roundHalfUp((in*inputPrice + out*outputPrice) / 1_000_000)
 * = roundHalfUp((10*1_250_000 + 5*10_000_000) / 1e6)
 * = roundHalfUp(62_500_000 / 1e6) = roundHalfUp(62.5) = 63.
 */
const EXPECTED_COST =
  (MOCK_INPUT_TOKENS * INPUT_PRICE + MOCK_OUTPUT_TOKENS * OUTPUT_PRICE + PER_1M / 2n) / PER_1M;

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;
let apiKeyId: string;

/** A no-op queue: chat paths run blocking/stream, never enqueue. */
const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

/** Read a raw SSE response body into its `\n\n`-delimited frame blocks. */
async function readSseBlocks(res: Response): Promise<string[]> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('no SSE body');
  const decoder = new TextDecoder();
  let buffer = '';
  const blocks: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      blocks.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim().length > 0) blocks.push(buffer);
  return blocks;
}

async function settleRows(jobId: string): Promise<(typeof schema.ledgerTxn.$inferSelect)[]> {
  const rows = await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId));
  return rows.filter((l) => l.type === 'settle');
}

/** The single succeeded chat job created since the test started (newest first). */
async function latestChatJob(): Promise<typeof schema.job.$inferSelect | undefined> {
  const jobs = await db.select().from(schema.job).where(eq(schema.job.resourceId, CHAT_RESOURCE));
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
    ADMIN_JWT_SECRET: 'trackA-admin-secret',
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
    // The breaker (弹性2.0) over a fake Redis (no real Redis in this suite); it is
    // fail-open so even a no-op would not break routing, but a fake keeps it hermetic.
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

  // Tenant + funded account + api key.
  const [t] = await db.insert(schema.tenant).values({ name: 'trackA' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;
  apiKeyId = key.id;

  // Chat resource: provider `mock-chat`, stream + blocking, io_schema with NO
  // required inputs so the `__ir` passthrough (stripped before validation) is a
  // no-op. The relay constructs a model_token pricebook from the model's prices,
  // so no DB pricebook entry is strictly required — but one is seeded so the
  // resource is a valid run target via the shared RunService loads.
  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType: 'mock-chat',
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });
  // A DECOY DB pricebook entry priced DIFFERENTLY from the relay's in-process
  // model_token book (999/999 vs the model's µUSD/1M catalog rate). The relay
  // ignores the DB pricebook for chat and prices the settle off the model
  // catalog, so every settle must land at EXPECTED_COST (63 µUSD). If the engine
  // ever priced from this 999/999 row instead, the settle would differ and the
  // -EXPECTED_COST assertions below would fail — pinning M1 (relay path priced).
  await db.insert(schema.pricebookEntry).values({
    resourceId: CHAT_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing: 'post',
    spec: {
      method: 'model_token',
      inputPrice: 999,
      outputPrice: 999,
    },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: CHAT_RESOURCE,
    providerType: 'mock-chat',
    weight: 1,
    status: 'active',
  });

  // A real, public, active model row → the REAL MODEL_RESOLVER returns it.
  await createModel(db, {
    name: MODEL_NAME,
    resourceId: CHAT_RESOURCE,
    display: 'Mock Model',
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });

  // C2: a capability-restricted public model resolving to the same chat
  // resource. Sending `tools` to it makes `normalizeRequest` throw a
  // `ProtocolError('invalid_input')`, which the filter must surface as HTTP 400.
  await createModel(db, {
    name: NO_CAPS_MODEL,
    resourceId: CHAT_RESOURCE,
    display: 'Mock Model (no caps)',
    modality: 'chat',
    capabilities: { tools: false, vision: false, audio: false, json: false, stream: true },
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

describe('OpenAI dialect (/v1/chat/completions)', () => {
  it('non-stream → 200 chat.completion, settle-once, usage_log, model_token cost', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-actionow-channel')).toBe('mock-chat');
    const body = asRecord(await res.json());
    expect(body.object).toBe('chat.completion');
    const choice = asRecord((body.choices as unknown[])[0]);
    expect(asRecord(choice.message).content).toBe('hello');
    expect(asRecord(body.usage).completion_tokens).toBe(Number(MOCK_OUTPUT_TOKENS));

    const job = await latestChatJob();
    expect(job).toBeDefined();
    const jobId = job?.id ?? '';
    const rows = await settleRows(jobId);
    expect(rows).toHaveLength(1);
    // model_token cost: 10*3 + 5*7 = 65µ.
    expect(rows[0]?.creditsDelta).toBe(-EXPECTED_COST);
    expect(job?.costCredits).toBe(EXPECTED_COST);

    // A usage_log row was mirrored for this run (usageLogModel was set).
    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    const log = logs.find((l) => l.model === MODEL_NAME);
    expect(log).toBeDefined();
    expect(log?.inputTokens).toBe(Number(MOCK_INPUT_TOKENS));
    expect(log?.outputTokens).toBe(Number(MOCK_OUTPUT_TOKENS));
    expect(log?.cost).toBe(EXPECTED_COST);
    // P1c.1: the row is attributed to the calling api key (auth → relay → mirror).
    expect(log?.apiKeyId).toBe(apiKeyId);
  });

  it('stream:true → chat.completion.chunk frames ending data: [DONE], settle-once', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const blocks = await readSseBlocks(res);
    const dataLines = blocks.map((b) => b.replace(/^data:\s?/, ''));
    expect(dataLines.at(-1)).toBe('[DONE]');
    const chunks = dataLines.filter((d) => d !== '[DONE]').map((d) => asRecord(JSON.parse(d)));
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    const texts = chunks
      .map((c) => {
        const choices = c.choices as unknown[] | undefined;
        const first = choices?.[0];
        return first === undefined ? undefined : asRecord(asRecord(first).delta).content;
      })
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    expect(texts.join('')).toBe('hello');

    // C1 (revenue leak): the STREAM path must settle the true model_token cost,
    // not 0. Poll briefly for the generator's `finally` settle to commit, then
    // assert the newest succeeded chat job settled exactly -EXPECTED_COST (63 µUSD)
    // — proving the stream hold was sized big enough that the settle cap never
    // clamped the charge to the (formerly 0) hold.
    let job: typeof schema.job.$inferSelect | undefined;
    for (let i = 0; i < 40; i += 1) {
      job = await latestChatJob();
      if (job !== undefined && (await settleRows(job.id)).length === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toBeDefined();
    const jobId = job?.id ?? '';
    const settles = await settleRows(jobId);
    expect(settles).toHaveLength(1);
    // model_token cost off the model's 3/7 prices: 10*3 + 5*7 = 65µ (NOT 0).
    expect(settles[0]?.creditsDelta).toBe(-EXPECTED_COST);
    expect(job?.costCredits).toBe(EXPECTED_COST);

    // A usage_log row was mirrored for the streamed run with the true counts.
    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    const streamLog = logs
      .filter((l) => l.model === MODEL_NAME && l.cost === EXPECTED_COST)
      .find((l) => l.inputTokens === Number(MOCK_INPUT_TOKENS));
    expect(streamLog).toBeDefined();
    expect(streamLog?.inputTokens).toBe(Number(MOCK_INPUT_TOKENS));
    expect(streamLog?.outputTokens).toBe(Number(MOCK_OUTPUT_TOKENS));
  });
});

describe('subject attribution (端用户数据平面)', () => {
  it('a subject-scoped key records subject_id on the usage_log row', async () => {
    // A subject (end-user) + a key BOUND to it: the chat relay must thread the
    // subject id from the auth context into the RunRequest so usage_log/job is
    // attributed to the end-user (and the charge can route to its sub-wallet).
    const subj = await createSubject(db, { tenantId, externalId: 'chat-attr-subject' });
    const subjKey = await createApiKey(db, { tenantId, subjectId: subj.id });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${subjKey.plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);

    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.subjectId, subj.id));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]?.model).toBe(MODEL_NAME);
    expect(logs[0]?.apiKeyId).toBe(subjKey.id);
  });
});

describe('Anthropic dialect (/v1/messages)', () => {
  it('non-stream → type:message JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    const content = body.content as unknown[];
    expect(asRecord(content[0]).text).toBe('hello');

    // L1: assert another dialect's blocking path also settles the relay's
    // model_token cost (-65µ), not the decoy DB pricebook's 999/999.
    const job = await latestChatJob();
    const rows = await settleRows(job?.id ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-EXPECTED_COST);
    expect(job?.costCredits).toBe(EXPECTED_COST);
  });

  it('stream → event: message_start … event: message_stop', async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        max_tokens: 256,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const blocks = await readSseBlocks(res);
    const events = blocks.map((b) => {
      const line = b.split('\n').find((l) => l.startsWith('event:'));
      return line?.slice('event:'.length).trim();
    });
    expect(events[0]).toBe('message_start');
    expect(events.at(-1)).toBe('message_stop');
  });
});

describe('Gemini dialect (/v1beta/models/:model:generateContent)', () => {
  it('generateContent → candidates[0].content.parts', async () => {
    const res = await fetch(`${baseUrl}/v1beta/models/${MODEL_NAME}:generateContent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    const candidate = asRecord((body.candidates as unknown[])[0]);
    const parts = asRecord(candidate.content).parts as unknown[];
    expect(asRecord(parts[0]).text).toBe('hello');
  });

  it('streamGenerateContent → data: candidate frames', async () => {
    const res = await fetch(`${baseUrl}/v1beta/models/${MODEL_NAME}:streamGenerateContent`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    expect(res.status).toBe(200);
    const blocks = await readSseBlocks(res);
    const frames = blocks
      .filter((b) => b.startsWith('data:'))
      .map((b) => asRecord(JSON.parse(b.replace(/^data:\s?/, ''))));
    expect(frames.length).toBeGreaterThan(0);
    const text = frames
      .flatMap((f) => {
        const c = (f.candidates as unknown[] | undefined)?.[0];
        if (c === undefined) return [];
        const parts = asRecord(asRecord(c).content).parts as unknown[];
        return parts.map((p) => asRecord(p).text).filter((x): x is string => typeof x === 'string');
      })
      .join('');
    expect(text).toBe('hello');
  });
});

describe('errors + disconnect', () => {
  it('unknown model → 404 resource_not_found (real resolver returns undefined)', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'no-such-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(404);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('resource_not_found');
  });

  it('capability mismatch (tools on a no-tools model) → 400 invalid_input', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: NO_CAPS_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'x', parameters: { type: 'object' } },
          },
        ],
      }),
    });
    // normalizeRequest throws ProtocolError('invalid_input') — must be a client
    // 400 with the protocol error's code, NOT a 500 internal_error.
    expect(res.status).toBe(400);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('invalid_input');
  });

  it('disconnecting mid-stream settles exactly once', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Poll briefly for the async close handler, then assert every succeeded
    // chat job has exactly one settle row (settle-once holds for the aborted run).
    for (let i = 0; i < 40; i += 1) {
      const jobs = await db
        .select()
        .from(schema.job)
        .where(eq(schema.job.resourceId, CHAT_RESOURCE));
      const succeeded = jobs.filter((j) => j.status === 'succeeded');
      if (succeeded.length >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const jobs = await db.select().from(schema.job).where(eq(schema.job.resourceId, CHAT_RESOURCE));
    for (const j of jobs.filter((x) => x.status === 'succeeded')) {
      expect(await settleRows(j.id)).toHaveLength(1);
    }
    expect(
      (await db.select().from(schema.account).where(eq(schema.account.tenantId, tenantId)))[0]
        ?.creditHeld,
    ).toBe(0n);
  });
});

describe('idempotency (Idempotency-Key replay)', () => {
  it('replays the original chat job on a repeated Idempotency-Key (no double charge)', async () => {
    const key = 'relay-idem-key-1';
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = asRecord(await first.json());

    const second = await send();
    expect(second.status).toBe(200);
    const secondBody = asRecord(await second.json());

    // The replay returns the SAME logical result (content + usage + model). The
    // wire `id`/`created` are minted fresh per render and are not part of the
    // idempotency contract; the money proof is the one-job/one-settle assertion.
    expect(secondBody.choices).toEqual(firstBody.choices);
    expect(secondBody.usage).toEqual(firstBody.usage);
    expect(secondBody.model).toEqual(firstBody.model);

    // Exactly ONE job carries this idempotency key, settled exactly once →
    // a retried POST never creates a second job + hold + settle.
    const jobs = await db.select().from(schema.job).where(eq(schema.job.idempotencyKey, key));
    expect(jobs).toHaveLength(1);
    expect(await settleRows(jobs[0]?.id ?? '')).toHaveLength(1);
  });

  it('rejects a reused Idempotency-Key on a stream run with 400 invalid_input', async () => {
    const key = 'relay-idem-stream-1';
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    await readSseBlocks(first); // drain so the first stream settles cleanly

    // The reused key cannot re-open a live stream → 400 invalid_input (the claim
    // is rejected BEFORE any SSE byte, so the filter surfaces a real HTTP error).
    const second = await send();
    expect(second.status).toBe(400);
    const body = asRecord(await second.json());
    expect(asRecord(body.error).code).toBe('invalid_input');
  });
});

describe('discovery (GET /v1/models)', () => {
  it('lists the tenant-visible models in OpenAI list shape', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.object).toBe('list');
    const data = body.data as Record<string, unknown>[];
    expect(Array.isArray(data)).toBe(true);
    // Both seeded models are public + active → the REAL listVisibleModels
    // surfaces both, rendered as OpenAI `model` objects owned by `actionow`.
    const ids = data.map((m) => m.id);
    expect(ids).toContain(MODEL_NAME);
    expect(ids).toContain(NO_CAPS_MODEL);
    for (const m of data) {
      expect(m.object).toBe('model');
      expect(m.owned_by).toBe('actionow');
    }
  });
});
