import { AdapterError, createDefaultRegistry, type ProviderAdapter } from '@actionow/adapters';
import type { ChatResponse, ChatStreamEvent, SubmitResult } from '@actionow/contracts';
import {
  addChannelToGroup,
  createApiKey,
  createDb,
  createModel,
  createRouteGroup,
  type Database,
  schema,
  setApiKeyGroup,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import type { AppEnv } from '@actionow/infra';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';
import { UnifiedErrorFilter } from '../src/common/unified-error.filter.js';

/**
 * Track 4 group-scoped routing e2e. One chat resource owns TWO upstream
 * channels, each backed by a DISTINCT in-process chat adapter
 * (`mock-chat-a`/`mock-chat-b`), so the served channel is observable from the
 * `x-actionow-channel` response header (= the served channel's providerType) and
 * the mirrored `usage_log.channelId`/`providerType`.
 *
 * Channel A is a member of group `g1`, channel B of group `g2`. A key bound to
 * `g1` must be served by A only; a key bound to `g2` by B only; a key with NO
 * group resolves to the `default` group (which — having no members for this
 * resource — falls back to ALL active channels, so it is served by SOME channel);
 * and a key whose group has no members for the resource also falls back to all
 * channels (still served). This pins the v1 candidate-selection rule + the
 * backward-compatible ungrouped fallback.
 */

/** The seeded chat resource id (two channels, blocking). */
const CHAT_RESOURCE = 'group-chat-resource';
/** The public model name callers send. */
const MODEL_NAME = 'group-mock-model';
/** µUSD per 1M tokens (resale prices) seeded on the model. */
const INPUT_PRICE = 1_250_000n;
const OUTPUT_PRICE = 10_000_000n;

const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

/**
 * Build a deterministic in-process chat adapter under `providerType`. `chat()`
 * returns `'hello'` with fixed IR usage; never touches the network. Two of these
 * (distinct providerTypes) let the e2e tell which channel served.
 */
function labelledChatAdapter(providerType: string): ProviderAdapter {
  const USAGE = { inputTokens: 10, outputTokens: 5 } as const;
  return {
    providerType,
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    submit(): Promise<SubmitResult> {
      return Promise.resolve({
        kind: 'sync',
        output: { text: 'hello' },
        usage: { input_tokens: USAGE.inputTokens, output_tokens: USAGE.outputTokens },
      });
    },
    chat(): Promise<ChatResponse> {
      return Promise.resolve({
        message: { role: 'assistant', content: [{ kind: 'text', text: 'hello' }] },
        stopReason: 'stop',
        usage: { ...USAGE },
      });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'message_start' };
      yield { type: 'content_delta', text: 'hello' };
      yield { type: 'usage', usage: { ...USAGE } };
      yield { type: 'stop', stopReason: 'stop' };
      yield { type: 'done' };
    },
    extractUsage: () => ({ input_tokens: USAGE.inputTokens, output_tokens: USAGE.outputTokens }),
    mapError: () => ({ code: 'upstream_error', message: 'mock', retryable: false }),
  };
}

/**
 * A chat adapter whose `chat()` ALWAYS throws a RETRYABLE upstream error — drives
 * the cross-channel / cross-group failover path (弹性2.0). Used as the primary
 * group's only channel so the relay must cascade to the fallback group.
 */
function failingChatAdapter(providerType: string): ProviderAdapter {
  const fail = (): never => {
    throw new AdapterError({ code: 'upstream_error', message: 'mock 500', retryable: true });
  };
  return {
    providerType,
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    submit: fail,
    chat: fail,
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      fail();
    },
    extractUsage: () => ({ input_tokens: 0, output_tokens: 0 }),
    mapError: () => ({ code: 'upstream_error', message: 'mock 500', retryable: true }),
  };
}

const PROVIDER_A = 'mock-chat-a';
const PROVIDER_B = 'mock-chat-b';
/** Primary fallback-group channel: always 500s (retryable). */
const PROVIDER_FAIL = 'mock-chat-fail';
/** Fallback-group channel: always succeeds. */
const PROVIDER_OK = 'mock-chat-ok';

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let tenantId: string;

/** Plaintext keys bound to g1 / g2 / no-group / an empty group (no members). */
let keyG1: string;
let keyG2: string;
let keyNoGroup: string;
let keyEmptyGroup: string;
/** Key bound to a primary group whose only channel 500s → must fail over to the fallback group. */
let keyFallback: string;

/** Channel ids of A (in g1) and B (in g2). */
let channelAId: string;
let channelBId: string;
/** Channel ids for the cross-group failover scenario (primary 500s; fallback ok). */
let channelOkId: string;

let baseUrl: string;

/** POST a blocking chat completion with the given key; return the response. */
async function chat(key: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

/** The newest succeeded usage_log row for the model (records the served channel). */
async function latestUsageLog(): Promise<typeof schema.usageLog.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.usageLog)
    .where(eq(schema.usageLog.tenantId, tenantId));
  return rows
    .filter((l) => l.model === MODEL_NAME)
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
    ADMIN_JWT_SECRET: 'track4-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
  };

  // Default registry + the two labelled chat adapters so the served channel is
  // observable per providerType.
  const adapters = createDefaultRegistry();
  adapters.register(labelledChatAdapter(PROVIDER_A));
  adapters.register(labelledChatAdapter(PROVIDER_B));
  adapters.register(failingChatAdapter(PROVIDER_FAIL));
  adapters.register(labelledChatAdapter(PROVIDER_OK));

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
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  // Tenant + funded account.
  const [t] = await db.insert(schema.tenant).values({ name: 'track4' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(1000), creditHeld: 0n });

  // Chat resource (resource.providerType is irrelevant — each channel carries
  // its own providerType for cross-provider routing).
  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType: PROVIDER_A,
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });

  // Two channels: A → mock-chat-a, B → mock-chat-b.
  const [chA] = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: CHAT_RESOURCE, providerType: PROVIDER_A, weight: 1, status: 'active' })
    .returning();
  const [chB] = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: CHAT_RESOURCE, providerType: PROVIDER_B, weight: 1, status: 'active' })
    .returning();
  if (!chA || !chB) throw new Error('no channels');
  channelAId = chA.id;
  channelBId = chB.id;

  // Cross-group failover (弹性2.0): a primary channel that always 500s, and a
  // fallback channel that succeeds — on the SAME resource so the same model
  // resolves to both.
  const [chFail] = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: CHAT_RESOURCE, providerType: PROVIDER_FAIL, weight: 1, status: 'active' })
    .returning();
  const [chOk] = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: CHAT_RESOURCE, providerType: PROVIDER_OK, weight: 1, status: 'active' })
    .returning();
  if (!chFail || !chOk) throw new Error('no failover channels');
  channelOkId = chOk.id;

  // Public, active model resolving to the chat resource.
  await createModel(db, {
    name: MODEL_NAME,
    resourceId: CHAT_RESOURCE,
    display: 'Group Mock Model',
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });

  // The well-known `default` group (an unbound key resolves to it). It has NO
  // members for this resource → the ungrouped fallback to all channels applies.
  await createRouteGroup(db, { name: 'default', groupRatioBps: 10000 });

  // g1 ← channel A only; g2 ← channel B only; g-empty has no members.
  const g1 = await createRouteGroup(db, { name: 'g1' });
  const g2 = await createRouteGroup(db, { name: 'g2' });
  const gEmpty = await createRouteGroup(db, { name: 'g-empty' });
  await addChannelToGroup(db, { groupId: g1.id, channelId: channelAId });
  await addChannelToGroup(db, { groupId: g2.id, channelId: channelBId });

  // Cross-group failover: primary group (only the 500-ing channel) →
  // fallback_group_id = secondary group (only the succeeding channel).
  const gSecondary = await createRouteGroup(db, { name: 'g-secondary' });
  const gPrimary = await createRouteGroup(db, {
    name: 'g-primary',
    fallbackGroupId: gSecondary.id,
  });
  await addChannelToGroup(db, { groupId: gPrimary.id, channelId: chFail.id });
  await addChannelToGroup(db, { groupId: gSecondary.id, channelId: chOk.id });

  // Five keys bound to the group scenarios.
  const k1 = await createApiKey(db, { tenantId });
  const k2 = await createApiKey(db, { tenantId });
  const kNo = await createApiKey(db, { tenantId });
  const kEmpty = await createApiKey(db, { tenantId });
  const kFallback = await createApiKey(db, { tenantId });
  keyG1 = k1.plaintext;
  keyG2 = k2.plaintext;
  keyNoGroup = kNo.plaintext;
  keyEmptyGroup = kEmpty.plaintext;
  keyFallback = kFallback.plaintext;
  await setApiKeyGroup(db, k1.id, g1.id);
  await setApiKeyGroup(db, k2.id, g2.id);
  // kNo stays unbound (route_group_id null → resolves `default`).
  await setApiKeyGroup(db, kEmpty.id, gEmpty.id);
  await setApiKeyGroup(db, kFallback.id, gPrimary.id);
}, 120_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('group-scoped routing (Track 4)', () => {
  it('a key bound to g1 is served by channel A only', async () => {
    const res = await chat(keyG1);
    expect(res.status).toBe(200);
    // The served channel's providerType is reported in the header.
    expect(res.headers.get('x-actionow-channel')).toBe(PROVIDER_A);
    await res.json();
    const log = await latestUsageLog();
    expect(log?.channelId).toBe(channelAId);
    expect(log?.providerType).toBe(PROVIDER_A);
  });

  it('a key bound to g2 is served by channel B only', async () => {
    const res = await chat(keyG2);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-actionow-channel')).toBe(PROVIDER_B);
    await res.json();
    const log = await latestUsageLog();
    expect(log?.channelId).toBe(channelBId);
    expect(log?.providerType).toBe(PROVIDER_B);
  });

  it('a key with NO group resolves the default group → fallback serves an available channel', async () => {
    const res = await chat(keyNoGroup);
    expect(res.status).toBe(200);
    // The default group has no members for this resource → fall back to ALL
    // channels; SOME registered channel serves it.
    const served = res.headers.get('x-actionow-channel');
    expect([PROVIDER_A, PROVIDER_B]).toContain(served);
    await res.json();
    const log = await latestUsageLog();
    expect([channelAId, channelBId]).toContain(log?.channelId);
  });

  it('a key whose group has no members for the resource falls back to all channels (still served)', async () => {
    const res = await chat(keyEmptyGroup);
    expect(res.status).toBe(200);
    const served = res.headers.get('x-actionow-channel');
    expect([PROVIDER_A, PROVIDER_B]).toContain(served);
    await res.json();
    const log = await latestUsageLog();
    expect([channelAId, channelBId]).toContain(log?.channelId);
  });

  it('cross-group failover: primary group 500s → served by the fallback group (弹性2.0)', async () => {
    const res = await chat(keyFallback);
    expect(res.status).toBe(200);
    // The primary group's only channel always 500s (retryable) → the relay
    // cascades down the fallback_group_id chain to the secondary group's
    // succeeding channel.
    expect(res.headers.get('x-actionow-channel')).toBe(PROVIDER_OK);
    await res.json();
    const log = await latestUsageLog();
    expect(log?.channelId).toBe(channelOkId);
    expect(log?.providerType).toBe(PROVIDER_OK);
  });
});
