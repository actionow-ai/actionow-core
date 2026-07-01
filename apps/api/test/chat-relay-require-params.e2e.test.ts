import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createDefaultRegistry } from '@actionow/adapters';
import {
  addChannelToGroup,
  createApiKey,
  createDb,
  createModel,
  createRouteGroup,
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
 * P2-1..P2-3 (模型参数绑定 Phase 2): `require_params` routing (D3, DEFAULT OFF).
 *
 * A model links to TWO openai channels. Channel A carries a `delete top_p`
 * override (it does NOT support a `top_p` request); channel B keeps it. The key's
 * route group toggles `require_params`:
 *   - OFF (default): a request with `top_p` is served drop-and-forward, either
 *     channel may serve — the candidate set is unchanged (P2-1).
 *   - ON: channel A is SKIPPED, channel B serves (P2-2). With BOTH channels
 *     non-supporting, no candidate remains → 404 (P2-3).
 *
 * Served channel is read from `relay_trace.channel_id` (RELAY_TRACE:'full').
 */

const CHAT_RESOURCE = 'chat-openai-rp-resource';
const MODEL_NAME = 'rp-model';
const INPUT_PRICE = 1_250_000n;
const OUTPUT_PRICE = 10_000_000n;

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;
let modelId: string;
let channelAId: string;
let channelBId: string;
let groupId: string;

const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

let upstream: Server | undefined;
let fakeBase: string;

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

const CANNED_RESPONSE = {
  id: 'chatcmpl-rp',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/** Send an OpenAI-dialect chat request carrying `top_p` (no route tag → router picks). */
async function chatWithTopP(): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.5,
    }),
  });
}

/** Toggle the key's route group `require_params`. */
async function setRequireParams(on: boolean): Promise<void> {
  await db
    .update(schema.routeGroup)
    .set({ requireParams: on })
    .where(eq(schema.routeGroup.id, groupId));
}

/** The channel id of the newest relay_trace for the test tenant (which channel served). */
async function lastServedChannelId(): Promise<string | undefined> {
  const traces = await db
    .select()
    .from(schema.relayTrace)
    .where(eq(schema.relayTrace.tenantId, tenantId));
  return traces[traces.length - 1]?.channelId ?? undefined;
}

beforeAll(async () => {
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
    ADMIN_JWT_SECRET: 'require-params-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
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

  const [t] = await db.insert(schema.tenant).values({ name: 'require-params' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(1000), creditHeld: 0n });

  // Route group the key binds to — require_params starts OFF.
  const group = await createRouteGroup(db, { name: 'rp-group', requireParams: false });
  groupId = group.id;

  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;
  // Bind the key to the group (createApiKey has no routeGroupId param).
  await db.update(schema.apiKey).set({ routeGroupId: groupId }).where(eq(schema.apiKey.id, key.id));

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
    display: 'Require-Params Model',
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: true, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });
  modelId = model.id;

  // Both channels serve the model + are members of the key's group. Channel A
  // DELETES top_p (does not support it); channel B keeps it.
  await linkChannelModel(db, channelAId, model.id);
  await linkChannelModel(db, channelBId, model.id);
  await addChannelToGroup(db, { groupId, channelId: channelAId, priority: 10 });
  await addChannelToGroup(db, { groupId, channelId: channelBId, priority: 10 });
  await setChannelModelOverride(db, channelAId, model.id, {
    ops: [{ op: 'delete', name: 'top_p' }],
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

describe('require_params routing (mig 0065, D3)', () => {
  it('P2-1 require_params OFF (default): a top_p request is served, no channel skipped', async () => {
    await setRequireParams(false);
    const res = await chatWithTopP();
    expect(res.status).toBe(200);
    // Either channel may serve (drop-and-forward) — the point is it succeeds.
    const served = await lastServedChannelId();
    expect([channelAId, channelBId]).toContain(served);
  });

  it('P2-2 require_params ON: the non-supporting channel A is skipped, B serves', async () => {
    await setRequireParams(true);
    // Channel A (priority 10) would otherwise be tried first, but it DELETES top_p
    // → require_params skips it. Channel B is the only supporting candidate.
    const res = await chatWithTopP();
    expect(res.status).toBe(200);
    const served = await lastServedChannelId();
    expect(served).toBe(channelBId);
  });

  it('P2-3 require_params ON + NO supporting channel → 404 no-candidate', async () => {
    // Make channel B ALSO delete top_p → zero channels support the request.
    await setChannelModelOverride(db, channelBId, modelId, {
      ops: [{ op: 'delete', name: 'top_p' }],
    });
    const res = await chatWithTopP();
    expect(res.status).toBe(404);
    // Restore channel B (support top_p again) for isolation.
    await setChannelModelOverride(db, channelBId, modelId, null);
  });

  it('P2-1b require_params ON but request carries NO gated param → unchanged (served)', async () => {
    await setRequireParams(true);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] }),
    });
    // No top_p → nothing to gate → both channels eligible → served.
    expect(res.status).toBe(200);
    await setRequireParams(false);
  });
});
