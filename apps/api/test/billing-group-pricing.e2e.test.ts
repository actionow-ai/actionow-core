import { createDefaultRegistry, type ProviderAdapter } from '@actionow/adapters';
import type { ChatResponse, ChatStreamEvent, SubmitResult } from '@actionow/contracts';
import {
  addChannelToGroup,
  createApiKey,
  createDb,
  createModel,
  createRouteGroup,
  createUser,
  type Database,
  schema,
  setApiKeyGroup,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import type { AppEnv } from '@actionow/infra';
import { FakeRateLimitRedis, hashPassword, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';
import { UnifiedErrorFilter } from '../src/common/unified-error.filter.js';

/**
 * Track 5 billing e2e — `group_ratio` customer pricing + per-channel
 * cost/margin. One chat resource owns ONE channel (in-process `mock-chat`
 * adapter) that carries operator-cost rates. Three keys exercise the pricing:
 *
 * - `keyDefault` (unbound → the `default` group, ratio 10000 = ×1.0) settles the
 *   BASE model_token cost (the regression invariant — must stay 63 µUSD).
 * - `key2x` (a group with `group_ratio_bps = 20000`) settles EXACTLY 2× the base.
 * - both record the served channel's `provider_cost` (from its cost cols) and a
 *   `margin = cost − provider_cost`, with the customer charge unaffected by the
 *   channel cost.
 *
 * Plus an admin channel-CRUD round-trip proving the USD/1M cost DTO converts to
 * µUSD/1M and is clearable on PATCH.
 */

const CHAT_RESOURCE = 'billing-chat-resource';
const MODEL_NAME = 'billing-mock-model';
/** µUSD per 1M tokens (customer resale prices) seeded on the model. */
const INPUT_PRICE = 1_250_000n;
const OUTPUT_PRICE = 10_000_000n;
/** The served channel's operator-cost rates (µUSD per 1M tokens). */
const CH_INPUT_COST = 500_000n;
const CH_OUTPUT_COST = 4_000_000n;

/** The fixed mock usage: in=10 / out=5. */
const USAGE = { inputTokens: 10, outputTokens: 5 } as const;
// Base customer cost (default ×1.0 group ratio):
//   roundHalfUp((10*1_250_000 + 5*10_000_000)/1e6) = roundHalfUp(62.5e6/1e6) = 63.
const BASE_COST = 63n;
// 2× group ratio (20000 bps): roundHalfUp(62.5e6 × 20000 / (1e6×10000)) = 125.
const DOUBLE_COST = 125n;
// provider_cost: roundHalfUp((10*500_000 + 5*4_000_000)/1e6) = roundHalfUp(25e6/1e6) = 25.
const PROVIDER_COST = 25n;

const PROVIDER = 'mock-chat';
const ADMIN_SECRET = 'billing-admin-secret';
const ADMIN_EMAIL = 'admin-billing@actionow.local';
const ADMIN_PASSWORD = 'hunter2';

const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

/** A deterministic in-process chat adapter: `'hello'` + fixed usage; never networks. */
function mockChatAdapter(providerType: string): ProviderAdapter {
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

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
/** The bootstrapped HTTP server (set in beforeAll) the admin supertest calls hit. */
let httpServer: ReturnType<INestApplication['getHttpServer']>;
let tenantId: string;
let channelId: string;
let keyDefault: string;
let key2x: string;
let baseUrl: string;
let adminToken: string;

/** Set the admin bearer token on a supertest request. */
function adminAuth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${adminToken}`);
}

/** POST a blocking chat completion with the given key. */
async function chat(key: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

/** The newest succeeded usage_log row for the model. */
async function latestUsageLog(): Promise<typeof schema.usageLog.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.usageLog)
    .where(eq(schema.usageLog.tenantId, tenantId));
  return rows
    .filter((l) => l.model === MODEL_NAME)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/** The newest succeeded chat job's settled cost (µUSD); null/undefined when absent. */
async function latestJobCost(): Promise<bigint | null | undefined> {
  const rows = await db.select().from(schema.job).where(eq(schema.job.tenantId, tenantId));
  return rows
    .filter((j) => j.status === 'succeeded')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.costCredits;
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
    ADMIN_JWT_SECRET: ADMIN_SECRET,
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
  };

  const adapters = createDefaultRegistry();
  adapters.register(mockChatAdapter(PROVIDER));

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
  httpServer = app.getHttpServer();
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  // Tenant + funded account.
  const [t] = await db.insert(schema.tenant).values({ name: 'billing' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(1000), creditHeld: 0n });

  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType: PROVIDER,
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });

  // ONE channel carrying the operator-cost rates (→ provider_cost/margin).
  const [ch] = await db
    .insert(schema.upstreamChannel)
    .values({
      resourceId: CHAT_RESOURCE,
      providerType: PROVIDER,
      weight: 1,
      status: 'active',
      inputCostPer1m: CH_INPUT_COST,
      outputCostPer1m: CH_OUTPUT_COST,
    })
    .returning();
  if (!ch) throw new Error('no channel');
  channelId = ch.id;

  await createModel(db, {
    name: MODEL_NAME,
    resourceId: CHAT_RESOURCE,
    display: 'Billing Mock Model',
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });

  // The well-known `default` group (ratio ×1.0) an unbound key resolves to. It
  // has NO members for this resource → the ungrouped fallback routes the one
  // channel. A second group `g2x` at ratio 2.0× owns the channel so its key is
  // served (and priced 2×) by it.
  await createRouteGroup(db, { name: 'default', groupRatioBps: 10000 });
  const g2x = await createRouteGroup(db, { name: 'g2x', groupRatioBps: 20000 });
  await addChannelToGroup(db, { groupId: g2x.id, channelId });

  const kDefault = await createApiKey(db, { tenantId });
  const k2x = await createApiKey(db, { tenantId });
  keyDefault = kDefault.plaintext;
  key2x = k2x.plaintext;
  // kDefault stays unbound (→ the `default` group, ×1.0).
  await setApiKeyGroup(db, k2x.id, g2x.id);

  // An admin user for the channel-CRUD round-trip.
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const login = await request(httpServer)
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  adminToken = login.body.token as string;
}, 180_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('group_ratio customer pricing + per-channel cost/margin (Track 5)', () => {
  it('default-group key settles the BASE cost (×1.0 regression invariant) + provider_cost/margin', async () => {
    const res = await chat(keyDefault);
    expect(res.status).toBe(200);
    await res.json();

    // The default group is ×1.0 → the base model_token cost (unchanged from Track 1).
    expect(await latestJobCost()).toBe(BASE_COST);

    const log = await latestUsageLog();
    expect(log?.cost).toBe(BASE_COST);
    expect(log?.channelId).toBe(channelId);
    // provider_cost from the served channel's cost cols; margin = cost − provider_cost.
    expect(log?.providerCost).toBe(PROVIDER_COST);
    expect((log?.cost ?? 0n) - (log?.providerCost ?? 0n)).toBe(BASE_COST - PROVIDER_COST);
  });

  it('a key in a group with group_ratio_bps=20000 is charged EXACTLY 2× the base', async () => {
    const res = await chat(key2x);
    expect(res.status).toBe(200);
    await res.json();

    // 2.0× group ratio → the single-round price 125 (not 63×2=126: the base 62.5
    // is rounded ONCE after the ratio is folded in, not twice). Still EXACTLY 2×
    // the un-rounded base 62.5, distinct from the default group's 63.
    expect(await latestJobCost()).toBe(DOUBLE_COST);

    const log = await latestUsageLog();
    expect(log?.cost).toBe(DOUBLE_COST);
    // The customer charge doubled, but provider_cost (operator cost) is the SAME —
    // the channel cost is independent of the customer group ratio.
    expect(log?.providerCost).toBe(PROVIDER_COST);
    // Margin grows with the ratio: 125 − 25 = 100.
    expect((log?.cost ?? 0n) - (log?.providerCost ?? 0n)).toBe(DOUBLE_COST - PROVIDER_COST);
  });

  it('GET /admin/analytics/usage by model reports summed provider_cost + margin', async () => {
    const res = await adminAuth(request(httpServer).get('/admin/analytics/usage'))
      .query({ groupBy: 'model' })
      .expect(200);
    const rows = res.body as {
      bucket: string;
      cost: string;
      provider_cost: string;
      margin: string;
    }[];
    const row = rows.find((r) => r.bucket === MODEL_NAME);
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('no usage rollup row for the model');
    // margin must equal cost − provider_cost for the bucket.
    expect(BigInt(row.margin)).toBe(BigInt(row.cost) - BigInt(row.provider_cost));
    expect(BigInt(row.provider_cost)).toBeGreaterThan(0n);
  });

  it('admin channel CRUD round-trips USD/1M cost → µUSD/1M and clears on PATCH null', async () => {
    // Create a fresh channel with HUMAN USD/1M cost rates ($0.50 in / $4 out).
    const created = await adminAuth(
      request(httpServer).post(`/admin/resources/${CHAT_RESOURCE}/channels`),
    )
      .send({ providerType: PROVIDER, inputCostUsdPer1m: 0.5, outputCostUsdPer1m: 4 })
      .expect(201);
    // $0.50/1M → 500_000 µUSD/1M; $4/1M → 4_000_000 µUSD/1M.
    expect(created.body.input_cost_per_1m).toBe('500000');
    expect(created.body.output_cost_per_1m).toBe('4000000');
    const newChannelId = created.body.id as string;

    // PATCH null clears the input cost; sets output to $9/1M.
    const patched = await adminAuth(
      request(httpServer).patch(`/admin/resources/${CHAT_RESOURCE}/channels/${newChannelId}`),
    )
      .send({ inputCostUsdPer1m: null, outputCostUsdPer1m: 9 })
      .expect(200);
    expect(patched.body.input_cost_per_1m).toBeNull();
    expect(patched.body.output_cost_per_1m).toBe('9000000');
  });
});
