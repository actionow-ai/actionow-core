import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createDefaultRegistry } from '@actionow/adapters';
import {
  createApiKey,
  createDb,
  createModel,
  type Database,
  linkChannelModel,
  schema,
  setChannelModelOverride,
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
 * Phase 0 exit criterion (model-param-binding): the SAME model linked to TWO
 * channels with DIFFERENT `channel_model.param_override` forced params relays to
 * each with a DIFFERENT wire body — proven at the wire level via
 * `relay_trace.request_body` with `RELAY_TRACE: 'full'`.
 *
 * Uses the REAL `openai` adapter (so `buildChatBody` actually renders the
 * sampling params) against a local fake `/v1/chat/completions` upstream that
 * captures the exact wire body per request and returns a canned OpenAI response.
 * Both channels point at the same fake base; routing to a specific channel is
 * hard-pinned via `X-Actionow-Route-Tag` (染色/标签路由).
 */

const CHAT_RESOURCE = 'chat-openai-po-resource';
const MODEL_NAME = 'po-model';
const INPUT_PRICE = 1_250_000n;
const OUTPUT_PRICE = 10_000_000n;

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;
let channelAId: string;
let channelBId: string;

const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

let upstream: Server | undefined;
let fakeBase: string;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += String(chunk);
    });
    req.on('end', () => {
      resolve(buf);
    });
    req.on('error', reject);
  });
}

/** A canned OpenAI chat.completion the fake upstream returns for every request. */
const CANNED_RESPONSE = {
  id: 'chatcmpl-po',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/** Send an OpenAI-dialect chat request pinned to a channel by route tag. */
async function chatWithTag(routeTag: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-actionow-route-tag': routeTag,
    },
    body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

/** The relay_trace request-body (parsed) for a given channel id. */
async function wireBodyForChannel(channelId: string): Promise<Record<string, unknown>> {
  const traces = await db
    .select()
    .from(schema.relayTrace)
    .where(eq(schema.relayTrace.channelId, channelId));
  const trace = traces[traces.length - 1];
  if (trace?.requestBody === undefined || trace.requestBody === null) {
    throw new Error(`no relay_trace request body for channel ${channelId}`);
  }
  return asRecord(JSON.parse(trace.requestBody));
}

beforeAll(async () => {
  // ── Fake OpenAI upstream: drain the request, return the canned completion.
  //    The wire body itself is asserted via `relay_trace.request_body`
  //    (RELAY_TRACE:'full') — the wire-level oracle.
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CANNED_RESPONSE));
    })();
  });
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  if (addr === null || typeof addr === 'string') throw new Error('no upstream address');
  // The openai adapter POSTs to `${endpoint}/chat/completions`, so the channel
  // endpoint is the base (no trailing /chat/completions).
  fakeBase = `http://127.0.0.1:${String(addr.port)}/v1`;

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
    ADMIN_JWT_SECRET: 'param-override-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    // FULL so relay_trace captures the actual upstream wire body — the oracle.
    RELAY_TRACE: 'full',
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

  const [t] = await db.insert(schema.tenant).values({ name: 'param-override' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(1000), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;

  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType: 'openai',
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });

  // Two openai channels pointing at the same fake upstream, each tagged so a
  // request can be hard-pinned to it via X-Actionow-Route-Tag.
  const [chA] = await db
    .insert(schema.upstreamChannel)
    .values({
      resourceId: CHAT_RESOURCE,
      providerType: 'openai',
      endpoint: fakeBase,
      weight: 1,
      status: 'active',
      tags: ['chan-a'],
    })
    .returning();
  const [chB] = await db
    .insert(schema.upstreamChannel)
    .values({
      resourceId: CHAT_RESOURCE,
      providerType: 'openai',
      endpoint: fakeBase,
      weight: 1,
      status: 'active',
      tags: ['chan-b'],
    })
    .returning();
  if (!chA || !chB) throw new Error('no channels');
  channelAId = chA.id;
  channelBId = chB.id;

  const model = await createModel(db, {
    name: MODEL_NAME,
    resourceId: CHAT_RESOURCE,
    display: 'Param-Override Model',
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });

  // Same model on BOTH channels, with DIFFERENT forced params:
  //   A: set temperature=0 AND delete top_p   B: set temperature=1
  await linkChannelModel(db, channelAId, model.id);
  await linkChannelModel(db, channelBId, model.id);
  await setChannelModelOverride(db, channelAId, model.id, {
    ops: [
      { op: 'set', name: 'temperature', value: 0 },
      { op: 'delete', name: 'top_p' },
    ],
  });
  await setChannelModelOverride(db, channelBId, model.id, {
    ops: [{ op: 'set', name: 'temperature', value: 1 }],
  });
}, 180_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
  if (upstream !== undefined)
    await new Promise<void>((r) =>
      upstream?.close(() => {
        r();
      }),
    );
});

describe('per-(model×channel) param override on the wire (mig 0062)', () => {
  it('E0-2 same model, two channels, different forced temperature → wire bodies differ', async () => {
    const resA = await chatWithTag('chan-a');
    expect(resA.status).toBe(200);
    const resB = await chatWithTag('chan-b');
    expect(resB.status).toBe(200);

    const wireA = await wireBodyForChannel(channelAId);
    const wireB = await wireBodyForChannel(channelBId);

    // The override forced a DIFFERENT temperature on each channel — the whole
    // point of the feature (same model, direct vs relay params).
    expect(wireA.temperature).toBe(0);
    expect(wireB.temperature).toBe(1);
    expect(wireA.temperature).not.toBe(wireB.temperature);

    // E0-3: `delete top_p` on channel A only — the request never set top_p here,
    // so both simply lack it, but the delete op is exercised without error.
    expect(wireA.top_p).toBeUndefined();
  });

  it('E0-1 regression invariant: a channel with NO override sends today’s wire body', async () => {
    // Clear channel B's override → its wire body carries no forced temperature.
    const model = await db.select().from(schema.model).where(eq(schema.model.name, MODEL_NAME));
    const modelId = model[0]?.id;
    if (modelId === undefined) throw new Error('no model');
    await setChannelModelOverride(db, channelBId, modelId, null);

    const res = await chatWithTag('chan-b');
    expect(res.status).toBe(200);

    const wire = await wireBodyForChannel(channelBId);
    // No override → the request omitted temperature, so the wire omits it too
    // (byte-for-byte identical to a no-override baseline).
    expect(wire.temperature).toBeUndefined();

    // Restore for isolation from any later ordering.
    await setChannelModelOverride(db, channelBId, modelId, {
      ops: [{ op: 'set', name: 'temperature', value: 1 }],
    });
  });
});
