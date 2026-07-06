import type { ProviderAdapter } from '@actionow/adapters';
import { createDefaultRegistry } from '@actionow/adapters';
import type { AdapterContext, ChatStreamEvent } from '@actionow/contracts';
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
 * ⑤-S streaming model-fallback e2e. Boots a REAL HTTP server so the SSE response
 * genuinely streams over the wire (read via `fetch` chunked body). A custom
 * `bad-stream` adapter is registered whose `streamChat` fails on its FIRST event
 * — the failure mode is keyed off the channel's `config.mode`:
 *
 *   - `retryable`     → `upstream_error` (retryable) on the first frame (degrades)
 *   - `non-retryable` → `content_filtered` (non-retryable) on the first frame
 *   - `post-commit`   → a GOOD first frame, then a mid-stream `error` (in-band)
 *
 * The PRIMARY model resolves to the bad-served resource; its `fallbackModels`
 * point to a GOOD model served by `mock-chat`. The relay's `chatStream` loops the
 * chain, so a retryable pre-commit failure of the primary degrades to the good
 * fallback (the stream commits to it), a non-retryable failure does NOT, and an
 * all-fail chain surfaces a real HTTP error (NOT a 200 + in-band frame).
 */

const PROVIDER_BAD = 'bad-stream';
/** Resource served by the bad adapter (its channel `config.mode` picks the failure). */
const BAD_RESOURCE = 'chat-bad-resource';
/** Resource served by the good `mock-chat` adapter (the fallback target). */
const GOOD_RESOURCE = 'chat-good-resource';

/** Primary model whose only upstream fails RETRYABLY → degrades to GOOD_MODEL. */
const RETRYABLE_MODEL = 'fb-primary-retryable';
/** Primary model whose only upstream fails NON-RETRYABLY → no fallback. */
const NON_RETRYABLE_MODEL = 'fb-primary-non-retryable';
/** Primary whose fallback ALSO fails retryably → all fail pre-commit. */
const ALL_FAIL_MODEL = 'fb-primary-all-fail';
/** Primary that commits then errors mid-stream → in-band (post-commit). */
const POST_COMMIT_MODEL = 'fb-primary-post-commit';
/** The healthy fallback model (mock-chat → 'hello'). */
const GOOD_MODEL = 'fb-good';
/** A second bad model used as the all-fail chain's fallback. */
const BAD_FALLBACK_MODEL = 'fb-bad-fallback';

const INPUT_PRICE = 1_250_000n;
const OUTPUT_PRICE = 10_000_000n;
/** mock-chat fixed usage (in=10/out=5) → model_token cost (round-half-up) = 63 µUSD. */
const MOCK_INPUT_TOKENS = 10;
const MOCK_OUTPUT_TOKENS = 5;

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;

const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

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

/**
 * The `bad-stream` adapter: its `streamChat` reads `ctx.config.mode` and fails on
 * the first event accordingly (or, for `post-commit`, commits then errors
 * mid-stream). Pure, no network.
 */
function badStreamAdapter(): ProviderAdapter {
  return {
    providerType: PROVIDER_BAD,
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    submit: () => Promise.resolve({ kind: 'sync', output: {}, usage: {} }),
    chat: () =>
      Promise.resolve({
        message: { role: 'assistant', content: [{ kind: 'text', text: 'bad' }] },
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(_ir, ctx: AdapterContext): AsyncIterable<ChatStreamEvent> {
      const mode = (ctx.config?.mode as string | undefined) ?? 'retryable';
      if (mode === 'non-retryable') {
        yield {
          type: 'error',
          error: { code: 'content_filtered', message: 'nope', retryable: false },
        };
        return;
      }
      if (mode === 'post-commit') {
        yield { type: 'message_start' };
        yield { type: 'content_delta', text: 'pa' };
        yield {
          type: 'error',
          error: { code: 'upstream_error', message: 'boom', retryable: false },
        };
        return;
      }
      // default: retryable first-event failure
      yield { type: 'error', error: { code: 'upstream_error', message: '5xx', retryable: true } };
    },
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'bad-stream', retryable: false }),
  };
}

/** Seed a chat resource + version + one channel (optionally with a config). */
async function seedResource(
  resourceId: string,
  providerType: string,
  config?: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.resource).values({
    id: resourceId,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType,
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId,
    providerType,
    weight: 1,
    status: 'active',
    ...(config !== undefined ? { config } : {}),
  });
}

async function seedModel(
  name: string,
  resourceId: string,
  fallbackModels?: string[],
): Promise<void> {
  await createModel(db, {
    name,
    resourceId,
    display: name,
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
    ...(fallbackModels !== undefined ? { fallbackModels } : {}),
  });
}

async function streamChat(model: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
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
    ADMIN_JWT_SECRET: 'fb-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
  };

  const adapters = createDefaultRegistry();
  adapters.register(badStreamAdapter());

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

  const [t] = await db.insert(schema.tenant).values({ name: 'fb' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;

  // Resources: a good (mock-chat) one and bad (bad-stream) ones with distinct
  // failure modes via the channel config. Each model resolves to its resource.
  await seedResource(GOOD_RESOURCE, 'mock-chat');
  await seedResource(BAD_RESOURCE, PROVIDER_BAD, { mode: 'retryable' });
  await seedResource('chat-bad-nr-resource', PROVIDER_BAD, { mode: 'non-retryable' });
  await seedResource('chat-bad-pc-resource', PROVIDER_BAD, { mode: 'post-commit' });

  await seedModel(GOOD_MODEL, GOOD_RESOURCE);
  await seedModel(BAD_FALLBACK_MODEL, BAD_RESOURCE); // a second retryable-bad model
  await seedModel(RETRYABLE_MODEL, BAD_RESOURCE, [GOOD_MODEL]);
  await seedModel(NON_RETRYABLE_MODEL, 'chat-bad-nr-resource', [GOOD_MODEL]);
  await seedModel(ALL_FAIL_MODEL, BAD_RESOURCE, [BAD_FALLBACK_MODEL]);
  await seedModel(POST_COMMIT_MODEL, 'chat-bad-pc-resource', [GOOD_MODEL]);
}, 120_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('streaming model-fallback (OpenAI dialect)', () => {
  it('(a) retryable pre-commit failure → commits to the fallback model; usage_log records the SERVED model', async () => {
    const res = await streamChat(RETRYABLE_MODEL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const blocks = await readSseBlocks(res);
    const dataLines = blocks.map((b) => b.replace(/^data:\s?/, ''));
    expect(dataLines.at(-1)).toBe('[DONE]');
    const chunks = dataLines.filter((d) => d !== '[DONE]').map((d) => asRecord(JSON.parse(d)));
    const texts = chunks
      .map((c) => {
        const first = (c.choices as unknown[] | undefined)?.[0];
        return first === undefined ? undefined : asRecord(asRecord(first).delta).content;
      })
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    // The good fallback served → the client received its content ('hello').
    expect(texts.join('')).toBe('hello');
    // The chunks are labeled with the SERVED (fallback) model, not the primary.
    expect(chunks.every((c) => c.model === undefined || c.model === GOOD_MODEL)).toBe(true);

    // The usage_log row records the SERVED (fallback) model with the served counts.
    let log: typeof schema.usageLog.$inferSelect | undefined;
    for (let i = 0; i < 40; i += 1) {
      const logs = await db
        .select()
        .from(schema.usageLog)
        .where(eq(schema.usageLog.tenantId, tenantId));
      log = logs.find((l) => l.model === GOOD_MODEL && l.status === 'succeeded');
      if (log !== undefined) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(log).toBeDefined();
    expect(log?.inputTokens).toBe(MOCK_INPUT_TOKENS);
    expect(log?.outputTokens).toBe(MOCK_OUTPUT_TOKENS);
    // The primary (failed pre-commit) model never settled a succeeded usage_log row.
    const all = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    expect(all.some((l) => l.model === RETRYABLE_MODEL && l.status === 'succeeded')).toBe(false);
  });

  it('(b) non-retryable first error → NO fallback + real HTTP error', async () => {
    const res = await streamChat(NON_RETRYABLE_MODEL);
    // The throw reaches the global filter before any SSE byte → a real HTTP error,
    // NOT a 200 + in-band frame. content_filtered → 422 (statusForCode table).
    expect(res.status).toBe(422);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('content_filtered');
  });

  it('(c) ALL models fail pre-commit → real HTTP error (NOT 200 + error frame)', async () => {
    const res = await streamChat(ALL_FAIL_MODEL);
    expect(res.status).not.toBe(200);
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('upstream_error');
  });

  it('(d) post-commit mid-stream error → still in-band (200, content then an error frame, no [DONE])', async () => {
    const res = await streamChat(POST_COMMIT_MODEL);
    // The first event committed → headers already flushed → 200, the mid-stream
    // error is handled in-band (OpenAI renders it as a `data: {"error": ...}`
    // frame and the stream ends WITHOUT [DONE] — never a forged clean stop).
    expect(res.status).toBe(200);
    const blocks = await readSseBlocks(res);
    const dataLines = blocks.map((b) => b.replace(/^data:\s?/, ''));
    expect(dataLines).not.toContain('[DONE]');
    const chunks = dataLines.map((d) => asRecord(JSON.parse(d)));
    const texts = chunks
      .map((c) => {
        const first = (c.choices as unknown[] | undefined)?.[0];
        return first === undefined ? undefined : asRecord(asRecord(first).delta).content;
      })
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    // The pre-error content ('pa') reached the client; the stream did not fall over.
    expect(texts.join('')).toBe('pa');
    // The terminal frame is the OpenAI-wire error (official SDKs raise on it).
    const last = asRecord(chunks.at(-1)?.error);
    expect(last.code).toBe('upstream_error');
    expect(last.type).toBe('server_error');
    // No chunk forged a clean stop.
    const finishReasons = chunks
      .map((c) => (c.choices as unknown[] | undefined)?.[0])
      .filter((f): f is Record<string, unknown> => f !== undefined)
      .map((f) => asRecord(f).finish_reason);
    expect(finishReasons).not.toContain('stop');
  });
});
