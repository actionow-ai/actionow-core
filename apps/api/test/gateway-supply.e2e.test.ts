// apps/api/test/gateway-supply.e2e.test.ts
//
// model-supply-greenfield 批次4 slice6 — the FULL-SEAM gateway e2e over a real
// testcontainers postgres + the REAL AppModule HTTP face. Verbatim 判据
// coverage:
//
//   2.2 同一视频模型经两条异构供给项对外语义一致 — offering A rides an
//       AK/SK-credential channel with fetch=submit_poll, offering B an
//       api-key channel with fetch=direct; BOTH answer 202 + Task on
//       POST /v1/videos/generations, reach `succeeded` (A via the §7.2
//       worker sweep, B via the in-process at-most-once runner), echo the
//       ACTUAL offering in `served_by`, and deliver the §7.6 webhook
//       envelope (timestamped HMAC verified) + the SSE terminal frame.
//   2.8 自动升格 — a slow-marked images.generation model answers 202 + Task
//       on the generic POST /v1/tasks; the fast twin answers 200 sync. (SDK
//       submit-and-wait's digestion of the SAME dual shape is locked by
//       packages/sdk/src/task.test.ts over a mock server.)
//   2.9 task 路由对齐 — X-Actionow-Route-Tag pins the candidate set on the
//       TASK path exactly like sync: an untagged higher-tier offering is
//       excluded, the pinned top-tier offering 500s at submit and the task
//       FAILOVERS to the pinned sibling (per-hop replan); a zero-match tag
//       is a 400. (Breaker gating of the same planner path is locked by
//       packages/engine/test/planner/planner.int.test.ts — one planner
//       serves both paradigms by construction.)
//
// Only the upstream wire is faked (a scripted HttpClient + two mock dialects
// registered under the SAME versioned-registry mechanism production uses);
// planner, §7.8 gates, task rows, settle/ledger and the HTTP controllers are
// all real.
import { createHmac } from 'node:crypto';

import type {
  CredentialSecret,
  GatewayUsage,
  HttpClient,
  HttpResponse,
  HttpStreamResponse,
  ModelOperation,
} from '@actionow/contracts';
import {
  createSupplyChannel,
  createSupplyCredential,
  createSupplyModel,
  createSupplyOffering,
  createSupplyPriceCard,
  createSupplyProvider,
  hashApiKey,
  schema,
} from '@actionow/db';
import {
  DefaultBreakerStore,
  sweepRecoverableTasks,
  TaskWebhookDispatcher,
} from '@actionow/engine';
import { verifyTaskWebhookSignature } from '@actionow/engine';
import {
  FakeBreakerRedis,
  FakeConcurrencyLimiter,
  FakeRateLimitRedis,
  RedisRateLimiter,
} from '@actionow/infra';
import type { Dialect } from '@actionow/spi';
import { DialectRegistry, openaiDialect } from '@actionow/spi';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, like, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { pgBreakerPersistence, resolveChannelBreakerConfig } from '../src/common/breaker-store.js';
import {
  BREAKER,
  CONCURRENCY_LIMITER,
  DB,
  ENV,
  JOB_QUEUE,
  RATE_LIMITER,
} from '../src/common/tokens.js';
import { GATEWAY_DIALECTS, GATEWAY_HTTP } from '../src/gateway/gateway.tokens.js';

/** The vault master key credentials are encrypted with. */
const VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
const RAW_API_KEY = 'ak_gateway_e2e_1';
const WEBHOOK_SECRET = 'whsec_gateway_e2e';
const CALLBACK_URL = 'https://callbacks.example.test/hooks/tasks';

// --- the scripted upstream (fake HttpClient routed by absolute URL) -----------------

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string> | undefined;
}

type RouteHandler = (req: RecordedRequest) => { status: number; body: unknown };

class RouterHttp implements HttpClient {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, RouteHandler>();

  on(method: string, url: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${url}`, handler);
  }

  request(req: {
    method: string;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<HttpResponse> {
    const recorded: RecordedRequest = {
      method: req.method,
      url: req.url,
      body: req.body,
      headers: req.headers,
    };
    this.requests.push(recorded);
    const handler = this.routes.get(`${req.method} ${req.url}`);
    if (handler === undefined) {
      return Promise.resolve({ status: 404, ok: false, body: { error: 'no route' }, text: '{}' });
    }
    const res = handler(recorded);
    return Promise.resolve({
      status: res.status,
      ok: res.status < 400,
      body: res.body,
      text: JSON.stringify(res.body ?? null),
    });
  }

  stream(): Promise<HttpStreamResponse> {
    return Promise.reject(new Error('gateway-supply e2e: no stream upstreams scripted'));
  }
}

// --- the two mock dialects (§2.2 异构: AK/SK+submit_poll vs apikey+direct) ------------

/** Shared error table: 5xx → failover-eligible upstream_error (the §8 loop's food). */
const ERROR_TABLE: Dialect['errorTable'] = {
  rows: [
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: false },
    { match: { httpStatus: [500, 599] }, code: 'upstream_error', retryable: true, failover: true },
    { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: false },
};

interface UpstreamTaskBody {
  taskId: string;
  status: string;
  progress?: number;
  output?: unknown;
  usage?: GatewayUsage;
}

function parseQuery(res: { body: unknown }): UpstreamTaskBody {
  return res.body as UpstreamTaskBody;
}

/** Channel dialect A: AK/SK credential scheme + submit_poll task lifecycle. */
function akskDialect(): Dialect {
  return {
    ref: 'mock.aksk',
    version: 'v1',
    operations: { 'video.generation': { fetchModes: ['submit_poll'] } },
    requestMapping: {
      map: (input) => ({
        method: 'POST',
        path: '/aksk/run',
        bodyKind: 'json',
        body: { model: input.upstreamModelName, ...input.params.upstream },
      }),
    },
    credentialInjection: {
      // The AK/SK signer shape (batch-2 volc precedent, minified): the wire
      // proof that the ak_sk credential pool reached this channel.
      injectCredential: (draft, secret: CredentialSecret) => {
        if (secret.scheme !== 'ak_sk') throw new Error('akskDialect requires an ak_sk secret');
        const mac = createHmac('sha256', secret.secret_key)
          .update(`${draft.method} ${draft.path}`)
          .digest('hex')
          .slice(0, 16);
        return {
          ...draft,
          headers: { ...(draft.headers ?? {}), 'x-aksk': `${secret.access_key}:${mac}` },
        };
      },
    },
    responseNormalization: {
      normalize: (res) =>
        res.status === 200
          ? {
              ok: true,
              output: (res.body as { output?: unknown }).output,
              usage: { metrics: {}, billingDims: {}, estimated: false },
            }
          : {
              ok: false,
              error: {
                code: 'upstream_error',
                message: `aksk HTTP ${String(res.status)}`,
                retryable: false,
                failover: res.status >= 500,
              },
            },
      normalizeStreamFrame: () => [],
    },
    taskLifecycle: {
      buildSubmit: (input) => ({
        method: 'POST',
        path: '/aksk/submit',
        bodyKind: 'json',
        body: { model: input.upstreamModelName, ...input.params.upstream },
      }),
      parseSubmitResponse: (res) => {
        const body = res.body as { taskId?: string; error?: string };
        if (res.status !== 200 || body.taskId === undefined) {
          return {
            error: {
              code: 'upstream_error',
              message: body.error ?? `aksk submit rejected (HTTP ${String(res.status)})`,
              retryable: false,
              failover: res.status >= 500,
            },
          };
        }
        return { upstreamTaskId: body.taskId };
      },
      buildQuery: (id) => ({ method: 'GET', path: `/aksk/tasks/${id}`, bodyKind: 'none' }),
      parseQueryResponse: (res) => {
        const body = parseQuery(res);
        return {
          upstreamTaskId: body.taskId,
          status: body.status as 'running',
          ...(body.progress !== undefined ? { progress: body.progress } : {}),
          ...(body.output !== undefined ? { output: body.output } : {}),
          ...(body.usage !== undefined ? { usage: body.usage } : {}),
        };
      },
      verifyCallback: () => true,
      parseCallback: (raw) => JSON.parse(raw.rawBody) as never,
    },
    errorTable: ERROR_TABLE,
  };
}

/** Channel dialect B: plain api-key (bearer) + one-shot direct fetch. */
function bearerDialect(): Dialect {
  return {
    ref: 'mock.bearer',
    version: 'v1',
    operations: {
      'video.generation': { fetchModes: ['direct'] },
      'images.generation': { fetchModes: ['direct'] },
    },
    requestMapping: {
      map: (input) => ({
        method: 'POST',
        path: '/bearer/run',
        bodyKind: 'json',
        body: { model: input.upstreamModelName, ...input.params.upstream },
      }),
    },
    credentialInjection: {
      injectCredential: (draft, secret: CredentialSecret) => ({
        ...draft,
        headers: {
          ...(draft.headers ?? {}),
          authorization: `Bearer ${secret.scheme === 'bearer' ? secret.api_key : 'none'}`,
        },
      }),
    },
    responseNormalization: {
      normalize: (res) => {
        const body = res.body as {
          ok?: boolean;
          output?: unknown;
          metrics?: Record<string, number>;
        };
        if (res.status === 200 && body.ok === true) {
          return {
            ok: true,
            output: body.output,
            usage: { metrics: body.metrics ?? {}, billingDims: {}, estimated: false },
          };
        }
        return {
          ok: false,
          error: {
            code: 'upstream_error',
            message: `bearer HTTP ${String(res.status)}`,
            retryable: res.status >= 500,
            failover: res.status >= 500,
          },
        };
      },
      normalizeStreamFrame: () => [],
    },
    taskLifecycle: {
      buildSubmit: () => ({ method: 'POST', path: '/bearer/submit', bodyKind: 'json', body: {} }),
      parseSubmitResponse: () => ({
        error: {
          code: 'upstream_error',
          message: 'bearer channel has no task lifecycle',
          retryable: false,
          failover: false,
        },
      }),
      buildQuery: (id) => ({ method: 'GET', path: `/bearer/tasks/${id}`, bodyKind: 'none' }),
      parseQueryResponse: () => ({ upstreamTaskId: 'none', status: 'failed' as const }),
      verifyCallback: () => false,
      parseCallback: (raw) => JSON.parse(raw.rawBody) as never,
    },
    errorTable: ERROR_TABLE,
  };
}

// --- suite state ---------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let http: RouterHttp;
let registry: DialectRegistry;
let originalVaultKey: string | undefined;

beforeAll(async () => {
  originalVaultKey = process.env.SECRET_ENCRYPTION_KEY;
  process.env.SECRET_ENCRYPTION_KEY = VAULT_KEY;

  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  http = new RouterHttp();
  registry = new DialectRegistry();
  registry.register(akskDialect());
  registry.register(bearerDialect());
  // 预案③ (批次5 slice3): the REAL baseline openai dialect serves the
  // flag=true chat/embeddings leg below over the same versioned registry.
  registry.register(openaiDialect);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(CONCURRENCY_LIMITER)
    .useValue(new FakeConcurrencyLimiter())
    .overrideProvider(JOB_QUEUE)
    .useValue({ enqueueExec: () => Promise.reject(new Error('gateway e2e must not enqueue')) })
    .overrideProvider(BREAKER)
    .useValue(
      new DefaultBreakerStore({
        redis: new FakeBreakerRedis(),
        persistence: pgBreakerPersistence(db),
        configFor: (channelId: string) => resolveChannelBreakerConfig(db, channelId),
      }),
    )
    .overrideProvider(GATEWAY_DIALECTS)
    .useValue(registry)
    .overrideProvider(GATEWAY_HTTP)
    .useValue(http)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'test',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      ALLOW_DEV_TENANT_HEADER: false,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
    })
    .compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
}, 240_000);

afterAll(async () => {
  if (originalVaultKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = originalVaultKey;
  await app.close();
  await client.end();
  await container.stop();
});

afterEach(async () => {
  http.requests.length = 0;
  await db.execute(
    sql`TRUNCATE TABLE webhook_deliveries, task_events, task, ledger_txn, supply_offering_breaker, supply_model_grant, supply_offering, supply_credential, supply_model, supply_channel, supply_provider, supply_price_card, secret_material, secret_ref, api_key, account, tenant RESTART IDENTITY CASCADE`,
  );
});

// --- seed helpers (real slice-1 repos; the planner.int.test 范式) ----------------------

async function mkTenantAccountKey(balance = 10_000_000n): Promise<{
  tenantId: string;
  accountId: string;
  apiKeyId: string;
}> {
  const [t] = await db
    .insert(schema.tenant)
    .values({ name: 'gw-e2e', config: { webhook_secret: WEBHOOK_SECRET } })
    .returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(schema.account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const [k] = await db
    .insert(schema.apiKey)
    .values({ tenantId: t.id, hash: hashApiKey(RAW_API_KEY) })
    .returning();
  if (!k) throw new Error('api_key insert returned no row');
  return { tenantId: t.id, accountId: a.id, apiKeyId: k.id };
}

function videoOp(): ModelOperation {
  return {
    operation: 'video.generation',
    paradigms: ['task'],
    slow: false,
    params: [{ name: 'prompt', type: 'string', billingRelevant: false, required: true }],
  };
}

function imageOp(slow: boolean): ModelOperation {
  return {
    operation: 'images.generation',
    paradigms: ['sync', 'task'],
    slow,
    params: [{ name: 'prompt', type: 'string', billingRelevant: false, required: true }],
  };
}

interface ChainSeed {
  offeringId: string;
  channelId: string;
  modelId: string;
}

/** provider → channel(+baseUrl/tags/auth) → credential → offering, onto a model. */
async function mkOffering(o: {
  slug: string;
  modelId: string;
  dialectRef: 'mock.aksk' | 'mock.bearer';
  baseUrl: string;
  tags?: string[];
  secret: CredentialSecret;
  fetchMode: 'direct' | 'submit_poll';
  tier?: number;
  costCardId?: string;
}): Promise<ChainSeed> {
  const provider = await createSupplyProvider(db, {
    slug: o.slug,
    name: `Brand ${o.slug}`,
    defaultDialect: { ref: o.dialectRef, version: 'v1' },
  });
  const channel = await createSupplyChannel(db, {
    providerId: provider.id,
    name: `${o.slug}-ch`,
    authScheme: o.secret.scheme === 'ak_sk' ? 'ak_sk' : 'bearer',
    baseUrl: o.baseUrl,
    ...(o.tags !== undefined ? { tags: o.tags } : {}),
  });
  await createSupplyCredential(db, {
    channelId: channel.id,
    name: `${o.slug}-key`,
    secret: o.secret,
    keyB64: VAULT_KEY,
    quota: { rpm: null, tpm: null, max_concurrency: 4 },
  });
  const offering = await createSupplyOffering(db, {
    modelId: o.modelId,
    channelId: channel.id,
    status: 'enabled',
    upstreamModelName: `up-${o.slug}`,
    fetchProfile: { mode: o.fetchMode },
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
    ...(o.costCardId !== undefined ? { costPriceCardId: o.costCardId } : {}),
  });
  return { offeringId: offering.id, channelId: channel.id, modelId: o.modelId };
}

async function mkModel(name: string, operations: ModelOperation[]): Promise<string> {
  const sale = await createSupplyPriceCard(db, {
    name: `sale-${name}`,
    method: 'fixed',
    unit: 'request',
    spec: { method: 'fixed', amount: 5_000 },
  });
  const model = await createSupplyModel(db, {
    name,
    displayName: `Model ${name}`,
    modality: 'video',
    operations,
    status: 'active',
    visibility: 'public',
    priceCardId: sale.id,
  });
  return model.id;
}

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${RAW_API_KEY}`);
}

interface TaskViewBody {
  id: string;
  object: string;
  status: string;
  output: unknown;
  served_by: { offering_id: string } | null;
  usage: { metrics: Record<string, number> } | null;
}

async function pollTaskUntilTerminal(taskId: string, tries = 60): Promise<TaskViewBody> {
  for (let i = 0; i < tries; i++) {
    const res = await authed(request(app.getHttpServer()).get(`/v1/tasks/${taskId}`)).expect(200);
    const body = res.body as TaskViewBody;
    if (['succeeded', 'failed', 'canceled', 'expired'].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`task ${taskId} did not reach a terminal status in time`);
}

// --- 判据 2.2 — 同一视频模型 × 两条异构供给项, 对外语义一致 -----------------------------

describe('判据 2.2 — one video model over two heterogeneous offerings', () => {
  it('AK/SK + submit_poll: 202 + Task → worker sweep polls to succeeded; served_by echoes offering A; webhook + SSE deliver', async () => {
    await mkTenantAccountKey();
    const modelId = await mkModel('seedance-e2e', [videoOp()]);
    const cost = await createSupplyPriceCard(db, {
      name: 'cost-aksk',
      method: 'fixed',
      unit: 'request',
      spec: { method: 'fixed', amount: 1_000 },
    });
    const offA = await mkOffering({
      slug: 'aksk-a',
      modelId,
      dialectRef: 'mock.aksk',
      baseUrl: 'https://up-a.test',
      tags: ['route-a'],
      secret: { scheme: 'ak_sk', access_key: 'AKID_E2E', secret_key: 'SK_E2E' },
      fetchMode: 'submit_poll',
      costCardId: cost.id,
    });

    http.on('POST', 'https://up-a.test/aksk/submit', () => ({
      status: 200,
      body: { taskId: 'up-A-1' },
    }));
    http.on('GET', 'https://up-a.test/aksk/tasks/up-A-1', () => ({
      status: 200,
      body: {
        taskId: 'up-A-1',
        status: 'succeeded',
        output: { video_url: 'https://up-a.test/files/v.mp4' },
        usage: { metrics: { video_seconds: 5 }, billingDims: {}, estimated: false },
      },
    }));

    // ── create: 202 + Task, served_by = offering A. ─────────────────────────
    const created = await authed(request(app.getHttpServer()).post('/v1/videos/generations'))
      .set('X-Actionow-Route-Tag', 'route-a')
      .send({ model: 'seedance-e2e', prompt: 'a red bicycle', callback_url: CALLBACK_URL })
      .expect(202);
    expect(created.body.object).toBe('task');
    expect(created.body.served_by).toEqual({ offering_id: offA.offeringId });
    const taskId = created.body.id as string;

    // The AK/SK credential provably reached the wire (aspect ③).
    const submit = http.requests.find((r) => r.url === 'https://up-a.test/aksk/submit');
    expect(submit?.headers?.['x-aksk']).toMatch(/^AKID_E2E:/);

    // ── §7.2: expire the api node's lease, then the worker sweep takes over
    //    and polls to terminal (the same engine the task-poll processor runs).─
    await db
      .update(schema.task)
      .set({ leaseUntil: new Date(Date.now() - 120_000) })
      .where(eq(schema.task.id, taskId));
    const summary = await sweepRecoverableTasks({
      db,
      dialectRegistry: registry,
      spiHttp: http,
      ownerNode: 'e2e-worker',
      sleep: () => Promise.resolve(),
    });
    expect(summary.claimed).toBe(1);
    expect(summary.outcomes.settled).toBe(1);

    const view = await pollTaskUntilTerminal(taskId);
    expect(view.status).toBe('succeeded');
    expect(view.output).toEqual({ video_url: 'https://up-a.test/files/v.mp4' });
    expect(view.served_by).toEqual({ offering_id: offA.offeringId });
    expect(view.usage?.metrics).toEqual({ video_seconds: 5 });

    // ── §7.6 webhook: envelope enqueued + dispatched with the timestamped
    //    HMAC the tenant secret verifies; evt_id idempotent across sweeps. ───
    http.on('POST', CALLBACK_URL, () => ({ status: 200, body: { received: true } }));
    const dispatcher = new TaskWebhookDispatcher({
      resolveSecret: () => Promise.resolve(WEBHOOK_SECRET),
      assertEgressAllowed: () => Promise.resolve(),
    });
    const dispatched = await dispatcher.dispatchDue(db, http, new Date());
    expect(dispatched.sent).toBeGreaterThanOrEqual(1);
    const delivery = http.requests.find(
      (r) => r.url === CALLBACK_URL && r.headers?.['X-Actionow-Event'] === 'task.succeeded',
    );
    expect(delivery).toBeDefined();
    const rawBody = JSON.stringify(delivery?.body);
    const header = delivery?.headers?.['X-Actionow-Signature'] ?? '';
    expect(
      verifyTaskWebhookSignature(WEBHOOK_SECRET, rawBody, header, {
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);
    const envelope = delivery?.body as { evt_id: string; event_type: string; task: { id: string } };
    expect(envelope.event_type).toBe('task.succeeded');
    expect(envelope.evt_id).toBe(`evt_${taskId}_succeeded`);
    expect(envelope.task.id).toBe(taskId);
    // Re-dispatch: nothing left pending (send-side evt_id idempotency).
    const again = await dispatcher.dispatchDue(db, http, new Date());
    expect(again.processed).toBe(0);

    // ── SSE: the terminal snapshot + terminal frame flow immediately. ───────
    const sse = await authed(request(app.getHttpServer()).get(`/v1/tasks/${taskId}/stream`)).expect(
      200,
    );
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.text).toContain('"status":"succeeded"');
  }, 120_000);

  it('api-key + direct: 202 + Task → in-process at-most-once runner settles; served_by echoes offering B; ledger attributes offering B', async () => {
    const seed = await mkTenantAccountKey();
    const modelId = await mkModel('seedance-e2e', [videoOp()]);
    const offB = await mkOffering({
      slug: 'bearer-b',
      modelId,
      dialectRef: 'mock.bearer',
      baseUrl: 'https://up-b.test',
      tags: ['route-b'],
      secret: { scheme: 'bearer', api_key: 'sk-bearer-e2e' },
      fetchMode: 'direct',
    });

    http.on('POST', 'https://up-b.test/bearer/run', () => ({
      status: 200,
      body: {
        ok: true,
        output: { video_url: 'https://up-b.test/v.mp4' },
        metrics: { video_seconds: 4 },
      },
    }));

    const created = await authed(request(app.getHttpServer()).post('/v1/videos/generations'))
      .set('X-Actionow-Route-Tag', 'route-b')
      .send({ model: 'seedance-e2e', prompt: 'a blue bicycle' })
      .expect(202);
    expect(created.body.object).toBe('task');
    expect(created.body.served_by).toEqual({ offering_id: offB.offeringId });

    const view = await pollTaskUntilTerminal(created.body.id as string);
    expect(view.status).toBe('succeeded');
    expect(view.output).toEqual({ video_url: 'https://up-b.test/v.mp4' });
    expect(view.served_by).toEqual({ offering_id: offB.offeringId });

    // The bearer credential reached the wire; the settle ledger row carries
    // the offering attribution (§9.2) and the charge moved the wallet.
    const run = http.requests.find((r) => r.url === 'https://up-b.test/bearer/run');
    expect(run?.headers?.authorization).toBe('Bearer sk-bearer-e2e');
    const ledger = await db
      .select()
      .from(schema.ledgerTxn)
      .where(like(schema.ledgerTxn.resourceId, `supply_offering:${offB.offeringId}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe('settle');
    expect(ledger[0]?.creditsDelta).toBe(-5_000n);
    const [account] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.id, seed.accountId));
    expect(account?.creditHeld).toBe(0n);
    expect(account?.creditBalance).toBe(10_000_000n - 5_000n);
  }, 120_000);
});

// --- 判据 2.8 — 自动升格: slow → 202 + Task, fast → 200 sync -----------------------------

describe('判据 2.8 — server-side auto-upgrade on the generic /v1/tasks create', () => {
  it('a FAST images.generation model answers 200 with the sync invoke body', async () => {
    await mkTenantAccountKey();
    const modelId = await mkModel('fast-image', [imageOp(false)]);
    const off = await mkOffering({
      slug: 'fast-bearer',
      modelId,
      dialectRef: 'mock.bearer',
      baseUrl: 'https://up-fast.test',
      secret: { scheme: 'bearer', api_key: 'sk-fast' },
      fetchMode: 'direct',
    });
    http.on('POST', 'https://up-fast.test/bearer/run', () => ({
      status: 200,
      body: {
        ok: true,
        output: { image_url: 'https://up-fast.test/i.png' },
        metrics: { images: 1 },
      },
    }));

    const res = await authed(request(app.getHttpServer()).post('/v1/tasks'))
      .send({ model: 'fast-image', type: 'images.generation', prompt: 'a bicycle sticker' })
      .expect(200);
    expect(res.body.object).toBeUndefined(); // sync body, not a Task
    expect(res.body.operation).toBe('images.generation');
    expect(res.body.output).toEqual({ image_url: 'https://up-fast.test/i.png' });
    expect(res.body.served_by.offering_id).toBe(off.offeringId);
  }, 120_000);

  it('a SLOW-marked images.generation model auto-upgrades: 202 + Task on the SAME endpoint', async () => {
    await mkTenantAccountKey();
    const modelId = await mkModel('slow-image', [imageOp(true)]);
    await mkOffering({
      slug: 'slow-bearer',
      modelId,
      dialectRef: 'mock.bearer',
      baseUrl: 'https://up-slow.test',
      secret: { scheme: 'bearer', api_key: 'sk-slow' },
      fetchMode: 'direct',
    });
    http.on('POST', 'https://up-slow.test/bearer/run', () => ({
      status: 200,
      body: {
        ok: true,
        output: { image_url: 'https://up-slow.test/i.png' },
        metrics: { images: 1 },
      },
    }));

    const res = await authed(request(app.getHttpServer()).post('/v1/tasks'))
      .send({ model: 'slow-image', type: 'images.generation', prompt: 'a slow bicycle' })
      .expect(202);
    expect(res.body.object).toBe('task');
    // the at-most-once runner still finishes the work server-side
    const view = await pollTaskUntilTerminal(res.body.id as string);
    expect(view.status).toBe('succeeded');
    // the discovery face carries the slow marker clients pre-judge with (§5)
    const models = await authed(request(app.getHttpServer()).get('/v1/gateway/models')).expect(200);
    const slow = (
      models.body.data as { id: string; operations: { operation: string; slow: boolean }[] }[]
    ).find((m) => m.id === 'slow-image');
    expect(slow?.operations[0]?.slow).toBe(true);
  }, 120_000);
});

// --- 判据 2.9 — task 路径的 route-tag 钉选 + 同规则 failover ------------------------------

describe('判据 2.9 — route-tag pin + failover on the task path', () => {
  it('pins to the tag (excluding an untagged higher-tier offering) and failovers off a 500ing pinned channel to the pinned sibling', async () => {
    await mkTenantAccountKey();
    const modelId = await mkModel('routed-video', [videoOp()]);
    // F: pinned tag, TOP tier — its submit 500s (failover-eligible).
    await mkOffering({
      slug: 'vip-fail',
      modelId,
      dialectRef: 'mock.aksk',
      baseUrl: 'https://up-fail.test',
      tags: ['vip'],
      secret: { scheme: 'ak_sk', access_key: 'AKID_F', secret_key: 'SK_F' },
      fetchMode: 'submit_poll',
      tier: 10,
    });
    // G: pinned tag, lower tier — healthy; the failover target.
    const offG = await mkOffering({
      slug: 'vip-ok',
      modelId,
      dialectRef: 'mock.aksk',
      baseUrl: 'https://up-g.test',
      tags: ['vip'],
      secret: { scheme: 'ak_sk', access_key: 'AKID_G', secret_key: 'SK_G' },
      fetchMode: 'submit_poll',
      tier: 5,
    });
    // H: NO tag, highest tier — must be EXCLUDED by the narrow-only pin.
    await mkOffering({
      slug: 'untagged-top',
      modelId,
      dialectRef: 'mock.aksk',
      baseUrl: 'https://up-h.test',
      secret: { scheme: 'ak_sk', access_key: 'AKID_H', secret_key: 'SK_H' },
      fetchMode: 'submit_poll',
      tier: 100,
    });

    http.on('POST', 'https://up-fail.test/aksk/submit', () => ({
      status: 503,
      body: { error: 'upstream down' },
    }));
    http.on('POST', 'https://up-g.test/aksk/submit', () => ({
      status: 200,
      body: { taskId: 'up-G-1' },
    }));

    const res = await authed(request(app.getHttpServer()).post('/v1/videos/generations'))
      .set('X-Actionow-Route-Tag', 'vip')
      .send({ model: 'routed-video', prompt: 'failover bicycle' })
      .expect(202);
    // tier 10 (F) was tried first, 500ed, and the §8 loop re-planned onto G —
    // the untagged tier-100 H never entered the candidate set.
    expect(res.body.served_by).toEqual({ offering_id: offG.offeringId });
    expect(http.requests.some((r) => r.url === 'https://up-fail.test/aksk/submit')).toBe(true);
    expect(http.requests.some((r) => r.url === 'https://up-g.test/aksk/submit')).toBe(true);
    expect(http.requests.some((r) => r.url.startsWith('https://up-h.test'))).toBe(false);
  }, 120_000);

  it('a zero-match route tag is a 400 (§8 narrow-only, never silently widened)', async () => {
    await mkTenantAccountKey();
    const modelId = await mkModel('routed-video', [videoOp()]);
    await mkOffering({
      slug: 'vip-only',
      modelId,
      dialectRef: 'mock.aksk',
      baseUrl: 'https://up-g.test',
      tags: ['vip'],
      secret: { scheme: 'ak_sk', access_key: 'AKID_G', secret_key: 'SK_G' },
      fetchMode: 'submit_poll',
      tier: 5,
    });

    const res = await authed(request(app.getHttpServer()).post('/v1/videos/generations'))
      .set('X-Actionow-Route-Tag', 'nope')
      .send({ model: 'routed-video', prompt: 'x' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  }, 120_000);
});

// --- 预案③ (批次5 slice3) — flag=true 的 chat/embeddings 走新网关全链 --------------------

describe('预案③ — gray-released tenant chat/embeddings ride the NEW gateway', () => {
  const CHAT_BASE = 'https://up-chat.test/v1';

  function chatOps(): ModelOperation[] {
    return [
      {
        operation: 'chat.completions',
        paradigms: ['sync', 'stream'],
        slow: false,
        params: [
          { name: 'messages', type: 'json', billingRelevant: false, required: true },
          {
            name: 'temperature',
            type: 'float',
            billingRelevant: false,
            required: false,
            default: 1,
            min: 0,
            max: 2,
          },
        ],
      },
      {
        operation: 'embeddings',
        paradigms: ['sync'],
        slow: false,
        params: [{ name: 'input', type: 'json', billingRelevant: false, required: true }],
      },
    ];
  }

  /** provider→channel→credential→offering on the REAL openai dialect (ref openai@1.0.0). */
  async function mkOpenAIOffering(modelId: string): Promise<ChainSeed> {
    const provider = await createSupplyProvider(db, {
      slug: 'openai-e2e',
      name: 'OpenAI e2e',
      defaultDialect: { ref: 'openai', version: '1.0.0' },
    });
    const channel = await createSupplyChannel(db, {
      providerId: provider.id,
      name: 'openai-e2e-ch',
      authScheme: 'bearer',
      baseUrl: CHAT_BASE,
    });
    await createSupplyCredential(db, {
      channelId: channel.id,
      name: 'openai-e2e-key',
      secret: { scheme: 'bearer', api_key: 'sk-chat-e2e' },
      keyB64: VAULT_KEY,
      quota: { rpm: null, tpm: null, max_concurrency: 4 },
    });
    const offering = await createSupplyOffering(db, {
      modelId,
      channelId: channel.id,
      status: 'enabled',
      upstreamModelName: 'up-gpt-e2e',
      fetchProfile: { mode: 'direct' },
    });
    return { offeringId: offering.id, channelId: channel.id, modelId };
  }

  /** 预案② per-tenant flag write (the SQL the cutover doc prescribes, via drizzle). */
  async function flagTenant(tenantId: string, value: boolean): Promise<void> {
    await db
      .update(schema.tenant)
      .set({ config: { webhook_secret: WEBHOOK_SECRET, gateway_v2: value } })
      .where(eq(schema.tenant.id, tenantId));
  }

  it('flag=true: POST /v1/chat/completions serves over the new gateway (facade 归一 → planner → openai dialect → settle) and renders the OpenAI wire; flag=false stays on the old world', async () => {
    const seed = await mkTenantAccountKey();
    const modelId = await mkModel('gpt-e2e', chatOps());
    const off = await mkOpenAIOffering(modelId);
    await flagTenant(seed.tenantId, true);

    http.on('POST', `${CHAT_BASE}/chat/completions`, () => ({
      status: 200,
      body: {
        id: 'chatcmpl-up-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'bonjour' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      },
    }));

    const messages = [{ role: 'user', content: 'say hi in french' }];
    const res = await authed(request(app.getHttpServer()).post('/v1/chat/completions'))
      .send({ model: 'gpt-e2e', messages })
      .expect(200);

    // OpenAI wire out (the new renderer), servedBy observable (§8).
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.model).toBe('gpt-e2e');
    expect(res.body.choices).toEqual([
      { index: 0, message: { role: 'assistant', content: 'bonjour' }, finish_reason: 'stop' },
    ]);
    expect(res.body.usage).toEqual({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
    expect(res.headers['x-actionow-offering']).toBe(off.offeringId);

    // Upstream wire in: offering's upstream_model_name, VERBATIM messages, the
    // layer-1 contract default (temperature 1) resolved through layer 2, and
    // the bearer credential injected by aspect ③.
    const upstream = http.requests.find((r) => r.url === `${CHAT_BASE}/chat/completions`);
    expect(upstream?.headers?.Authorization).toBe('Bearer sk-chat-e2e');
    expect(upstream?.body).toMatchObject({
      model: 'up-gpt-e2e',
      messages,
      temperature: 1,
    });

    // §9.2 the billing loop closed through the NEW chat face (sale card −5000).
    const ledger = await db
      .select()
      .from(schema.ledgerTxn)
      .where(like(schema.ledgerTxn.resourceId, `supply_offering:${off.offeringId}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe('settle');
    expect(ledger[0]?.creditsDelta).toBe(-5_000n);

    // 双面并存: flip the flag OFF → the SAME request rides the untouched old
    // relay, which does not know the supply-world model (404, old envelope).
    await flagTenant(seed.tenantId, false);
    await authed(request(app.getHttpServer()).post('/v1/chat/completions'))
      .send({ model: 'gpt-e2e', messages })
      .expect(404);
  }, 120_000);

  it('flag=true: POST /v1/embeddings serves over the new gateway and renders the OpenAI list', async () => {
    const seed = await mkTenantAccountKey();
    const modelId = await mkModel('gpt-e2e', chatOps());
    const off = await mkOpenAIOffering(modelId);
    await flagTenant(seed.tenantId, true);

    http.on('POST', `${CHAT_BASE}/embeddings`, () => ({
      status: 200,
      body: {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.25, 0.5] }],
        model: 'up-gpt-e2e',
        usage: { prompt_tokens: 6, total_tokens: 6 },
      },
    }));

    const res = await authed(request(app.getHttpServer()).post('/v1/embeddings'))
      .send({ model: 'gpt-e2e', input: 'hello world' })
      .expect(200);

    expect(res.body).toMatchObject({
      object: 'list',
      model: 'gpt-e2e',
      data: [{ object: 'embedding', index: 0, embedding: [0.25, 0.5] }],
      usage: { prompt_tokens: 6, total_tokens: 6 },
    });
    expect(res.headers['x-actionow-offering']).toBe(off.offeringId);
    const upstream = http.requests.find((r) => r.url === `${CHAT_BASE}/embeddings`);
    expect(upstream?.body).toMatchObject({ model: 'up-gpt-e2e', input: 'hello world' });
  }, 120_000);
});
