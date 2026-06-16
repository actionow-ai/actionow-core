import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ProviderAdapter } from '@actionow/adapters';
import { createDefaultRegistry } from '@actionow/adapters';
import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';
import { createApiKey, createDb, createUser, type Database, schema } from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import type { AppEnv } from '@actionow/infra';
import {
  createRedis,
  FetchHttpClient,
  hashPassword,
  type Redis,
  RedisRateLimiter,
} from '@actionow/infra';
import { type RunningWorkers, startWorkers, type WorkerRuntime } from '@actionow/worker';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV, RATE_LIMITER } from '../src/common/tokens.js';
import { UnifiedErrorFilter } from '../src/common/unified-error.filter.js';

/**
 * Phase 6 full-stack e2e. This is the FIRST test that boots a real HTTP server
 * (`app.listen(0)`) + a real BullMQ worker (`startWorkers`) against
 * Testcontainers Postgres + Redis, and drives the whole system over real HTTP
 * (`fetch`). Unlike the §12 acceptance e2e (NestJS `Test` harness + a noop
 * queue), JOB_QUEUE is the real `BullmqJobQueue` pointed at the test Redis, so
 * the async path runs api→Redis→worker→JobRunner→poll→settle for real, and the
 * webhook is delivered + HMAC-verified end to end.
 */

const ADMIN_SECRET = 'phase6-admin-secret';
const ADMIN_EMAIL = 'admin@phase6.local';
const ADMIN_PASSWORD = 'phase6-admin-password';
const FAKE_LLM = 'fake-llm';
const ASYNC_MEDIA = 'async-media-mock';
const STUB_TOKENS = 300;
/** The webhook signing secret wired into the worker runtime + recomputed here. */
const WEBHOOK_SECRET = 'phase6-webhook-secret';
const SIGNATURE_HEADER = 'x-actionow-signature';

/** A stubbed blocking LLM adapter — no network; fixed text + token usage. */
const fakeLlm: ProviderAdapter = {
  providerType: FAKE_LLM,
  submit(input: SubmitInput): Promise<SubmitResult> {
    return Promise.resolve({
      kind: 'sync',
      output: { text: `echo: ${String(input.inputs.prompt)}` },
      usage: { tokens: STUB_TOKENS },
    });
  },
  extractUsage(): UsageVector {
    return {};
  },
  mapError(): UnifiedError {
    return { code: 'upstream_error', message: 'fake', retryable: false };
  },
};

// Declared with `| undefined` so the afterAll teardown can guard each handle
// (a beforeAll that bails partway still tears down what it started).
let pg: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let workers: RunningWorkers | undefined;
let cbServer: Server | undefined;
let rateLimiterRedis: Redis | undefined;
let baseUrl: string;
let cbPort: number;
/** Received webhook callbacks: raw body + headers, pushed by the cb server. */
const callbacks: { rawBody: string; headers: Record<string, string | string[] | undefined> }[] = [];

/** A typed `fetch` JSON helper: returns the status + parsed body (unknown). */
async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  const body: unknown = text.length === 0 ? undefined : JSON.parse(text);
  return { status: res.status, body };
}

/** Narrow an unknown JSON value to a record so property access is type-safe. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

function bearer(token: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the full account row (balance + held) for a tenant. */
async function readAccount(tenantId: string): Promise<{ balance: bigint; held: bigint }> {
  const [row] = await db.select().from(schema.account).where(eq(schema.account.tenantId, tenantId));
  if (row === undefined) throw new Error(`no account for tenant ${tenantId}`);
  return { balance: row.creditBalance, held: row.creditHeld };
}

interface ResourceFixtureInput {
  resourceId: string;
  tenantId: string;
  providerType: string;
  modality: string;
  execModes: string[];
  /** unit-rate dimension (`tokens` for llm, `images` for async media). */
  rateDimension: string;
  rate: number;
}

/** Provision a runnable resource (resource + io_schema + unit/post pricebook + channel). */
async function provisionResource(input: ResourceFixtureInput): Promise<void> {
  await db.insert(schema.resource).values({
    id: input.resourceId,
    tenantId: input.tenantId,
    kind: 'model',
    modality: input.modality,
    providerType: input.providerType,
    execModes: input.execModes,
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: input.resourceId,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string' }],
    },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId: input.resourceId,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { [input.rateDimension]: { rate: input.rate } } },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: input.resourceId,
    providerType: input.providerType,
    weight: 1,
    status: 'active',
  });
}

/** A funded tenant + account + api key, returning the ids + plaintext key. */
async function provisionTenant(
  name: string,
  microCredits: bigint,
  keyOpts: { resourceAllowlist?: string[]; rateLimit?: number } = {},
): Promise<{ tenantId: string; accountId: string; apiKey: string }> {
  const [t] = await db.insert(schema.tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(schema.account)
    .values({ tenantId: t.id, creditBalance: microCredits, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const key = await createApiKey(db, { tenantId: t.id, ...keyOpts });
  return { tenantId: t.id, accountId: a.id, apiKey: key.plaintext };
}

// --- shared fixtures captured in beforeAll for the test bodies ---
let mainTenantId: string;
let mainApiKey: string;
const BLOCKING_RESOURCE = 'fake-llm-blocking';
const ASYNC_RESOURCE = 'async-media-image';

beforeAll(async () => {
  // 1. Containers.
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const pgUri = pg.getConnectionUri();
  const redisUri = redis.getConnectionUrl();

  // 2. DB + migrate.
  db = createDb(pgUri);
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  // 3. Test env. NODE_ENV=production turns OFF the x-tenant-id dev fallback so
  //    auth is real; REDIS_URL points the real BullmqJobQueue at the test redis.
  const env: AppEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: pgUri,
    REDIS_URL: redisUri,
    API_PORT: 0,
    LOG_LEVEL: 'info',
    RATE_LIMIT_TENANT_PER_MIN: 600,
    RATE_LIMIT_RESOURCE_PER_MIN: 600,
    ADMIN_JWT_SECRET: ADMIN_SECRET,
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
  };

  // 4. API adapter registry: the real default registry (async-media-mock ready
  //    after 1 poll) plus the stub fake-llm for the blocking path.
  const apiRegistry = createDefaultRegistry({ asyncMedia: { readyAfterPolls: 1 } });
  apiRegistry.register(fakeLlm);

  // 5. Boot the real API HTTP server. JOB_QUEUE is left as the real
  //    BullmqJobQueue (reads env.REDIS_URL → test redis); only DB/ENV/ADAPTERS
  //    and the rate limiter (test redis) are overridden.
  rateLimiterRedis = createRedis(redisUri);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ADAPTERS)
    .useValue(apiRegistry)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(rateLimiterRedis))
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.listen(0);
  // getUrl() can report the wildcard/IPv6 bind address (e.g. http://[::1]:PORT
  // or http://0.0.0.0:PORT); normalize to a loopback host fetch can reach.
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  // 6. Boot the real worker against the SAME test redis. The worker uses its own
  //    default registry (async-media-mock ready after 1 poll) + the fake-llm
  //    stub (unused on the async path but harmless) and a resolveSecret that
  //    returns WEBHOOK_SECRET for our callback URL so the dispatcher signs it.
  const workerRegistry = createDefaultRegistry({ asyncMedia: { readyAfterPolls: 1 } });
  workerRegistry.register(fakeLlm);
  const runtime: WorkerRuntime = {
    env,
    db,
    adapters: workerRegistry,
    http: new FetchHttpClient(),
    resolveSecret: (ref: string): Promise<string | undefined> =>
      Promise.resolve(ref.startsWith('http://127.0.0.1') ? WEBHOOK_SECRET : undefined),
  };
  workers = startWorkers(runtime, { webhookSweepMs: 250, reaperSweepMs: 500 });

  // 7. Callback server on an ephemeral port; capture each POST body + headers.
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      callbacks.push({ rawBody: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  cbServer = server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const cbAddr: string | AddressInfo | null = server.address();
  if (cbAddr === null || typeof cbAddr === 'string') throw new Error('cb server has no port');
  cbPort = cbAddr.port;

  // 8. Fixtures: admin user + a funded main tenant with a fake-llm blocking
  //    resource AND an async-media-mock resource.
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const main = await provisionTenant('phase6-main', creditsToMicro(100));
  mainTenantId = main.tenantId;
  mainApiKey = main.apiKey;
  await provisionResource({
    resourceId: BLOCKING_RESOURCE,
    tenantId: mainTenantId,
    providerType: FAKE_LLM,
    modality: 'text',
    execModes: ['blocking'],
    rateDimension: 'tokens',
    rate: 1,
  });
  await provisionResource({
    resourceId: ASYNC_RESOURCE,
    tenantId: mainTenantId,
    providerType: ASYNC_MEDIA,
    modality: 'image',
    execModes: ['async-poll'],
    rateDimension: 'images',
    rate: 100,
  });
}, 120_000);

afterAll(async () => {
  // Teardown in reverse boot order; tolerate undefined if beforeAll bailed.
  if (workers !== undefined) await workers.close();
  if (app !== undefined) await app.close();
  if (cbServer !== undefined) {
    const server = cbServer;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (rateLimiterRedis !== undefined) await rateLimiterRedis.quit();
  if (redis !== undefined) await redis.stop();
  if (pg !== undefined) await pg.stop();
});

describe('Phase 6 full-stack e2e (real server + real worker + real bullmq/redis)', () => {
  it('1. blocking run → 200 + output/usage/cost, settle ledger row + debit', async () => {
    const balanceBefore = (await readAccount(mainTenantId)).balance;

    const { status, body } = await fetchJson(
      `/v1/run/${BLOCKING_RESOURCE}`,
      bearer(mainApiKey, { inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } }),
    );
    expect(status).toBe(200);
    const rec = asRecord(body);
    expect(rec.status).toBe('succeeded');
    expect(rec.output).toEqual({ text: 'echo: hi' });
    expect(rec.usage).toEqual({ tokens: STUB_TOKENS });
    expect(rec.cost).toEqual({ credits: String(STUB_TOKENS) });
    const jobId = asString(rec.job_id);

    const settleRows = (
      await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(BigInt(-STUB_TOKENS));

    const acctAfter = await readAccount(mainTenantId);
    expect(acctAfter.balance).toBe(balanceBefore - BigInt(STUB_TOKENS));
    expect(acctAfter.held).toBe(0n);
  });

  it('2. async run over real BullMQ → 202 queued → poll → succeeded + settle + debit', async () => {
    const balanceBefore = (await readAccount(mainTenantId)).balance;

    // POST → 202 queued (api enqueues to redis; does NOT run inline).
    const queued = await fetchJson(
      `/v1/run/${ASYNC_RESOURCE}`,
      bearer(mainApiKey, { inputs: { prompt: 'a cat' }, estimated_usage: { images: 1 } }),
    );
    expect(queued.status).toBe(202);
    const queuedRec = asRecord(queued.body);
    expect(queuedRec.status).toBe('queued');
    const jobId = asString(queuedRec.job_id);

    // Poll GET /v1/jobs/:id until the worker drives it to succeeded (≤ ~15s).
    const deadline = Date.now() + 15_000;
    let finalRec: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const got = await fetchJson(`/v1/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${mainApiKey}` },
      });
      expect(got.status).toBe(200);
      const gotRec = asRecord(got.body);
      if (gotRec.status === 'succeeded') {
        finalRec = gotRec;
        break;
      }
      expect(['queued', 'running', 'succeeded']).toContain(gotRec.status);
      await sleep(200);
    }
    if (finalRec === undefined) throw new Error('async job did not reach succeeded within budget');

    // Output carries the mock media url; ledger settled; account debited (100µ).
    const output = asRecord(finalRec.output);
    expect(typeof output.image_url).toBe('string');
    expect(asString(output.image_url)).toContain('https://mock.local/');

    const settleRows = (
      await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(-100n);

    const acctAfter = await readAccount(mainTenantId);
    expect(acctAfter.balance).toBe(balanceBefore - 100n);
    expect(acctAfter.held).toBe(0n);
  });

  it('3. webhook delivery → callback server receives terminal job + valid HMAC', async () => {
    const callbackUrl = `http://127.0.0.1:${String(cbPort)}/hook`;
    const before = callbacks.length;

    const queued = await fetchJson(
      `/v1/run/${ASYNC_RESOURCE}`,
      bearer(mainApiKey, {
        inputs: { prompt: 'a dog' },
        estimated_usage: { images: 1 },
        callback_url: callbackUrl,
      }),
    );
    expect(queued.status).toBe(202);
    const jobId = asString(asRecord(queued.body).job_id);

    // Wait for the webhook-outbox sweep (250ms) to deliver the callback (≤ ~8s).
    const deadline = Date.now() + 8_000;
    while (callbacks.length === before && Date.now() < deadline) {
      await sleep(150);
    }
    expect(callbacks.length).toBeGreaterThan(before);
    const received = callbacks[callbacks.length - 1];
    if (received === undefined) throw new Error('no callback captured');

    // Body is the terminal job object: { job_id }.
    expect(asRecord(JSON.parse(received.rawBody)).job_id).toBe(jobId);

    // X-Actionow-Signature is HMAC-SHA256(secret, rawBody) — recompute + compare.
    const sigHeader = received.headers[SIGNATURE_HEADER];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    expect(typeof sig).toBe('string');
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(received.rawBody).digest('hex');
    expect(sig).toBe(expected);
  });

  it('4. rate limit (key rateLimit=2) → 3rd call 429 + retry_after_ms', async () => {
    const rl = await provisionTenant('phase6-ratelimit', creditsToMicro(100), {
      resourceAllowlist: ['rl-resource'],
      rateLimit: 2,
    });
    await provisionResource({
      resourceId: 'rl-resource',
      tenantId: rl.tenantId,
      providerType: FAKE_LLM,
      modality: 'text',
      execModes: ['blocking'],
      rateDimension: 'tokens',
      rate: 1,
    });

    const send = (): Promise<{ status: number; body: unknown }> =>
      fetchJson(
        `/v1/run/rl-resource`,
        bearer(rl.apiKey, { inputs: { prompt: 'rl' }, estimated_usage: { tokens: 1000 } }),
      );

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    const err = asRecord(asRecord(blocked.body).error);
    expect(err.code).toBe('rate_limited');
    expect(typeof err.retry_after_ms).toBe('number');
    expect(err.retry_after_ms as number).toBeGreaterThan(0);
  });

  it('5. auth: 401 bad key, 402 insufficient_credits (no job), idempotency replay → same job_id', async () => {
    // 401: missing key.
    const missing = await fetchJson(
      `/v1/run/${BLOCKING_RESOURCE}`,
      bearer('', { inputs: { prompt: 'hi' } }),
    );
    // an empty bearer is treated as missing/invalid → 401.
    expect(missing.status).toBe(401);
    expect(asRecord(asRecord(missing.body).error).code).toBe('unauthorized');

    // 401: invalid key.
    const invalid = await fetchJson(
      `/v1/run/${BLOCKING_RESOURCE}`,
      bearer('ak_not-a-real-key', { inputs: { prompt: 'hi' } }),
    );
    expect(invalid.status).toBe(401);
    expect(asRecord(asRecord(invalid.body).error).code).toBe('unauthorized');

    // 402: a low-balance tenant (100µ; too small for a 1000-token hold) → no job.
    const poor = await provisionTenant('phase6-poor', 100n, {
      resourceAllowlist: ['poor-resource'],
    });
    await provisionResource({
      resourceId: 'poor-resource',
      tenantId: poor.tenantId,
      providerType: FAKE_LLM,
      modality: 'text',
      execModes: ['blocking'],
      rateDimension: 'tokens',
      rate: 1,
    });
    const jobsBefore = await db.select().from(schema.job);
    const denied = await fetchJson(
      `/v1/run/poor-resource`,
      bearer(poor.apiKey, { inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } }),
    );
    expect(denied.status).toBe(402);
    expect(asRecord(asRecord(denied.body).error).code).toBe('insufficient_credits');
    const jobsAfter = await db.select().from(schema.job);
    expect(jobsAfter).toHaveLength(jobsBefore.length);

    // Idempotency: same key replays the original job, no double charge.
    const idemKey = `idem-${String(Date.now())}`;
    const reqBody = {
      inputs: { prompt: 'idem' },
      estimated_usage: { tokens: 1000 },
      idempotency_key: idemKey,
    };
    const first = await fetchJson(`/v1/run/${BLOCKING_RESOURCE}`, bearer(mainApiKey, reqBody));
    expect(first.status).toBe(200);
    const firstJobId = asString(asRecord(first.body).job_id);
    const balanceAfterFirst = (await readAccount(mainTenantId)).balance;

    const second = await fetchJson(`/v1/run/${BLOCKING_RESOURCE}`, bearer(mainApiKey, reqBody));
    expect(second.status).toBe(200);
    expect(asString(asRecord(second.body).job_id)).toBe(firstJobId);
    const settleRows = (
      await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, firstJobId))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect((await readAccount(mainTenantId)).balance).toBe(balanceAfterFirst);
  });

  it('6. admin login → dify import (fixed) 200 + io_schema; GET /v1/resources/:id; BYO+metered → 400', async () => {
    const login = await fetchJson('/admin/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const token = asString(asRecord(login.body).token);

    const yaml = `
app: { mode: workflow, name: phase6-xhs, icon: "🎨" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: topic, label: 主题, type: text-input, required: true, max_length: 100 } ] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: img1, data: { type: tool, provider_type: builtin, tool_name: dalle3 } }
      - { id: end, data: { type: end, outputs: [
            { variable: caption,   value_selector: [llm1, text] },
            { variable: image_url, value_selector: [img1, image] } ] } }
`;
    const difyResourceId = 'phase6-dify';
    const imported = await fetchJson('/admin/dify/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: mainTenantId,
        resourceId: difyResourceId,
        yaml,
        endpoint: 'https://dify.example/v1',
        pricingModel: 'fixed',
      }),
    });
    expect(imported.status).toBe(200);
    const impRec = asRecord(imported.body);
    expect(impRec.resource_id).toBe(difyResourceId);
    const ioSchema = asRecord(impRec.io_schema);
    expect((ioSchema.inputs as { key: string }[]).map((i) => i.key)).toEqual(['topic']);
    expect((ioSchema.outputs as { key: string }[]).map((o) => o.key)).toEqual([
      'caption',
      'image_url',
    ]);

    // GET /v1/resources/:id (api key) shows the io_schema.
    const got = await fetchJson(`/v1/resources/${difyResourceId}`, {
      headers: { authorization: `Bearer ${mainApiKey}` },
    });
    expect(got.status).toBe(200);
    const gotRec = asRecord(got.body);
    expect(gotRec.id).toBe(difyResourceId);
    const gotSchema = asRecord(gotRec.io_schema);
    expect((gotSchema.inputs as { key: string }[]).map((i) => i.key)).toEqual(['topic']);

    // BYO + metered → 400 metered_not_allowed.
    const metered = await fetchJson('/admin/dify/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: mainTenantId,
        resourceId: 'phase6-dify-metered',
        yaml,
        endpoint: 'https://dify.example/v1',
        pricingModel: 'metered',
      }),
    });
    expect(metered.status).toBe(400);
    const metErr = asRecord(asRecord(metered.body).error);
    expect(metErr.code).toBe('invalid_input');
    expect(asString(metErr.message)).toContain('metered_not_allowed');
  });
});
