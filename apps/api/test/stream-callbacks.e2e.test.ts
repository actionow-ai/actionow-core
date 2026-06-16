import { createHmac, randomUUID } from 'node:crypto';

import { createDefaultRegistry } from '@actionow/adapters';
import { createApiKey, createDb, type Database, schema } from '@actionow/db';
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
 * Phase 8 stream + callbacks e2e. Boots a REAL HTTP server (`app.listen(0)`) so
 * the SSE response genuinely streams over the wire (read via `fetch` chunked
 * body) and the disconnect-settles property is exercised by aborting the fetch
 * mid-stream. The callback path is driven by a signed `POST /v1/callbacks/...`
 * over the same real server.
 */

const SIGNATURE_HEADER = 'x-actionow-signature';
const STREAM_RESOURCE = 'mock-stream-resource';
const CALLBACK_RESOURCE = 'callback-resource';
/** A second callback resource whose channel config renames the signature header. */
const CONFIG_CALLBACK_RESOURCE = 'config-callback-resource';
/** The custom (vendor-neutral, config-driven) signature header for that channel. */
const CONFIG_SIGNATURE_HEADER = 'x-relay-signature';
/** The per-channel signing secret (resolved via SecretResolver from env). */
const CHANNEL_SECRET = 'phase8-channel-secret';
/** A fixed credential ref → the SecretResolver maps it to CHANNEL_SECRET. */
const CREDENTIAL_REF = '11111111-1111-1111-1111-111111111111';

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;

/** A no-op queue: stream/callback paths never enqueue. */
const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

/** Read an SSE response body fully, parsing `event:`/`data:` frames. */
async function readSse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('no SSE body');
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: { event: string; data: unknown }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      frames.push(parseFrame(block));
      idx = buffer.indexOf('\n\n');
    }
  }
  return frames;
}

function parseFrame(block: string): { event: string; data: unknown } {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
  }
  return { event, data: data.length === 0 ? undefined : JSON.parse(data) };
}

async function settleRows(jobId: string): Promise<(typeof schema.ledgerTxn.$inferSelect)[]> {
  const rows = await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId));
  return rows.filter((l) => l.type === 'settle');
}

async function readAccount(): Promise<{ balance: bigint; held: bigint }> {
  const [row] = await db.select().from(schema.account).where(eq(schema.account.tenantId, tenantId));
  if (row === undefined) throw new Error('no account');
  return { balance: row.creditBalance, held: row.creditHeld };
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pgUri = pg.getConnectionUri();
  db = createDb(pgUri);
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  // The SecretResolver maps CREDENTIAL_REF → CHANNEL_SECRET via this env key.
  const envKey = `SECRET_${CREDENTIAL_REF.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  process.env[envKey] = CHANNEL_SECRET;

  const env: AppEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: pgUri,
    REDIS_URL: 'redis://localhost:6379',
    API_PORT: 0,
    LOG_LEVEL: 'info',
    RATE_LIMIT_TENANT_PER_MIN: 600,
    RATE_LIMIT_RESOURCE_PER_MIN: 600,
    ADMIN_JWT_SECRET: 'phase8-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    // This suite authenticates over real Bearer API keys (NODE_ENV=production
    // already disables the fallback), so the dev tenant header stays off.
    ALLOW_DEV_TENANT_HEADER: false,
  };

  const adapters = createDefaultRegistry({ asyncMedia: { readyAfterPolls: 1 } });

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
  // rawBody:true so /v1/callbacks can HMAC-verify the exact received bytes.
  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  // Tenant + funded account + api key.
  const [t] = await db.insert(schema.tenant).values({ name: 'phase8' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;

  // Stream resource: post/unit pricebook (1µ/output_token) + mock-stream channel.
  await db.insert(schema.resource).values({
    id: STREAM_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'text',
    providerType: 'mock-stream',
    execModes: ['stream'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: STREAM_RESOURCE,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string' }],
    },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId: STREAM_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: STREAM_RESOURCE,
    providerType: 'mock-stream',
    weight: 1,
    status: 'active',
  });

  // Callback resource: pre/fixed pricebook (50µ) + async-media-mock channel with
  // a credential ref the SecretResolver maps to the signing secret.
  await db.insert(schema.resource).values({
    id: CALLBACK_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'image',
    providerType: 'async-media-mock',
    execModes: ['async-callback'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CALLBACK_RESOURCE,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'image_url', type: 'string' }],
    },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId: CALLBACK_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'fixed',
    timing: 'pre',
    spec: { method: 'fixed', amount: 50 },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: CALLBACK_RESOURCE,
    providerType: 'async-media-mock',
    credentialRef: CREDENTIAL_REF,
    weight: 1,
    status: 'active',
  });

  // Config-driven callback resource: identical to CALLBACK_RESOURCE but its
  // channel `config` renames the signature header (the vendor-neutral relay
  // protocol carries the header NAMES as data, not a hardcoded vendor header).
  await db.insert(schema.resource).values({
    id: CONFIG_CALLBACK_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'image',
    providerType: 'async-media-mock',
    execModes: ['async-callback'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CONFIG_CALLBACK_RESOURCE,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'image_url', type: 'string' }],
    },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId: CONFIG_CALLBACK_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'fixed',
    timing: 'pre',
    spec: { method: 'fixed', amount: 50 },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: CONFIG_CALLBACK_RESOURCE,
    providerType: 'async-media-mock',
    credentialRef: CREDENTIAL_REF,
    config: { signatureHeader: CONFIG_SIGNATURE_HEADER },
    weight: 1,
    status: 'active',
  });
}, 120_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('Phase 8 SSE streaming run (real server)', () => {
  it('streams delta/usage/done over SSE, settles exactly once + debits', async () => {
    const before = await readAccount();
    const res = await fetch(`${baseUrl}/v1/run/${STREAM_RESOURCE}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ inputs: { prompt: 'hi' }, estimated_usage: { output_tokens: 1000 } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSse(res);
    const deltas = frames.filter((f) => f.event === 'delta').map((f) => asRecord(f.data).text);
    expect(deltas).toEqual(['hel', 'lo']);

    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeDefined();
    const doneData = asRecord(done?.data);
    const jobId = String(doneData.jobId);
    // cost.credits is a µcredit decimal string (5 output_tokens * 1µ).
    expect(asRecord(doneData.cost).credits).toBe('5');

    const rows = await settleRows(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-5n);

    const after = await readAccount();
    expect(after.balance).toBe(before.balance - 5n);
    expect(after.held).toBe(0n);
  });

  it('settles exactly once when the client disconnects mid-stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/run/${STREAM_RESOURCE}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ inputs: { prompt: 'hi' }, estimated_usage: { output_tokens: 1000 } }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    // Read just the first frame, then abort → the server sees the socket close
    // and the generator's finally settles the job exactly once.
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Find the job that just streamed (the most recent stream-mode job) and
    // assert it settled exactly once. Poll briefly for the async close handler.
    let streamed: { id: string; status: string } | undefined;
    for (let i = 0; i < 40; i += 1) {
      const jobs = await db
        .select()
        .from(schema.job)
        .where(eq(schema.job.resourceId, STREAM_RESOURCE));
      const terminal = jobs
        .filter((j) => j.status === 'succeeded')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      // Two stream jobs exist now (full-consume + this one). Find one with a
      // settle row that is brand new for THIS test by checking there are exactly
      // two succeeded stream jobs, each with one settle row.
      if (terminal.length >= 2) {
        streamed = terminal[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(streamed).toBeDefined();

    // Every succeeded stream job has exactly one settle row (settle-once holds
    // for the disconnected run too).
    const jobs = await db
      .select()
      .from(schema.job)
      .where(eq(schema.job.resourceId, STREAM_RESOURCE));
    for (const j of jobs.filter((x) => x.status === 'succeeded')) {
      expect(await settleRows(j.id)).toHaveLength(1);
    }
    expect((await readAccount()).held).toBe(0n);
  });

  it('insufficient_credits → 402 before any SSE byte (no stream)', async () => {
    // Drain the tenant balance by holding far more than available is not easy
    // here; instead use a fresh poor tenant + resource.
    const [poorT] = await db.insert(schema.tenant).values({ name: 'phase8-poor' }).returning();
    if (!poorT) throw new Error('no tenant');
    await db
      .insert(schema.account)
      .values({ tenantId: poorT.id, creditBalance: 1n, creditHeld: 0n });
    const poorKey = (await createApiKey(db, { tenantId: poorT.id })).plaintext;
    const poorResource = 'poor-stream-resource';
    await db.insert(schema.resource).values({
      id: poorResource,
      tenantId: poorT.id,
      kind: 'model',
      modality: 'text',
      providerType: 'mock-stream',
      execModes: ['stream'],
      currentVersion: 1,
    });
    await db.insert(schema.resourceVersion).values({
      resourceId: poorResource,
      version: 1,
      ioSchema: {
        inputs: [{ key: 'prompt', type: 'string', required: true }],
        outputs: [{ key: 'text', type: 'string' }],
      },
    });
    await db.insert(schema.pricebookEntry).values({
      resourceId: poorResource,
      resourceVersion: 1,
      version: 1,
      method: 'unit',
      timing: 'post',
      spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
      active: true,
    });
    await db.insert(schema.upstreamChannel).values({
      resourceId: poorResource,
      providerType: 'mock-stream',
      weight: 1,
      status: 'active',
    });

    const jobsBefore = await db.select().from(schema.job);
    const res = await fetch(`${baseUrl}/v1/run/${poorResource}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${poorKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ inputs: { prompt: 'hi' }, estimated_usage: { output_tokens: 1000 } }),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = asRecord(await res.json());
    expect(asRecord(body.error).code).toBe('insufficient_credits');
    // No job created.
    const jobsAfter = await db.select().from(schema.job);
    expect(jobsAfter).toHaveLength(jobsBefore.length);
  });
});

describe('Phase 8 signed async-callback ingress (real server)', () => {
  /** Insert a job awaiting a callback (status running, upstream handle set). */
  async function seedAwaitingJob(upstreamId: string): Promise<string> {
    const jobId = randomUUID();
    await db.insert(schema.job).values({
      id: jobId,
      tenantId,
      resourceId: CALLBACK_RESOURCE,
      resourceVersion: 1,
      status: 'running',
      execMode: 'async-callback',
      inputs: { prompt: 'a cat' },
      upstreamJobHandle: upstreamId,
      quotedCredits: 50n,
    });
    return jobId;
  }

  function postCallback(rawBody: string, signature: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== undefined) headers[SIGNATURE_HEADER] = signature;
    return fetch(`${baseUrl}/v1/callbacks/async-media-mock`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
  }

  it('signed callback → settles exactly one ledger row; duplicate stays one', async () => {
    const upstreamId = `up-${randomUUID()}`;
    const jobId = await seedAwaitingJob(upstreamId);
    const before = await readAccount();

    const rawBody = JSON.stringify({ upstreamJobId: upstreamId, status: 'succeeded' });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('hex');

    const first = await postCallback(rawBody, sig);
    expect(first.status).toBe(200);
    expect(asRecord(await first.json()).settled).toBe(true);

    const rows = await settleRows(jobId);
    expect(rows).toHaveLength(1);
    // pre/fixed 50µ charged regardless of usage.
    expect(rows[0]?.creditsDelta).toBe(-50n);
    expect((await readAccount()).balance).toBe(before.balance - 50n);

    // Duplicate signed callback → still exactly one settle row (dedup-safe).
    const dup = await postCallback(rawBody, sig);
    expect(dup.status).toBe(200);
    expect(asRecord(await dup.json()).settled).toBe(false);
    expect(await settleRows(jobId)).toHaveLength(1);
  });

  it('bad signature → 401 unauthorized, no settle', async () => {
    const upstreamId = `up-${randomUUID()}`;
    const jobId = await seedAwaitingJob(upstreamId);

    const rawBody = JSON.stringify({ upstreamJobId: upstreamId, status: 'succeeded' });
    const res = await postCallback(rawBody, 'deadbeef'.repeat(8));
    expect(res.status).toBe(401);
    expect(asRecord(asRecord(await res.json()).error).code).toBe('unauthorized');

    expect(await settleRows(jobId)).toHaveLength(0);
  });

  it('missing signature → 401 unauthorized', async () => {
    const upstreamId = `up-${randomUUID()}`;
    await seedAwaitingJob(upstreamId);
    const rawBody = JSON.stringify({ upstreamJobId: upstreamId, status: 'succeeded' });
    const res = await postCallback(rawBody, undefined);
    expect(res.status).toBe(401);
  });
});

describe('Phase 8 config-driven callback header names (real server)', () => {
  /** Insert a job for the config-driven resource awaiting a callback. */
  async function seedConfigJob(upstreamId: string): Promise<string> {
    const jobId = randomUUID();
    await db.insert(schema.job).values({
      id: jobId,
      tenantId,
      resourceId: CONFIG_CALLBACK_RESOURCE,
      resourceVersion: 1,
      status: 'running',
      execMode: 'async-callback',
      inputs: { prompt: 'a cat' },
      upstreamJobHandle: upstreamId,
      quotedCredits: 50n,
    });
    return jobId;
  }

  function postWithHeader(
    rawBody: string,
    headerName: string,
    signature: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/callbacks/async-media-mock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [headerName]: signature },
      body: rawBody,
    });
  }

  it('verifies a callback signed under the config-named header', async () => {
    const upstreamId = `up-${randomUUID()}`;
    const jobId = await seedConfigJob(upstreamId);

    const rawBody = JSON.stringify({ upstreamJobId: upstreamId, status: 'succeeded' });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('hex');

    const res = await postWithHeader(rawBody, CONFIG_SIGNATURE_HEADER, sig);
    expect(res.status).toBe(200);
    expect(asRecord(await res.json()).settled).toBe(true);
    expect(await settleRows(jobId)).toHaveLength(1);
  });

  it('rejects the same callback sent under the default header name (names come from config)', async () => {
    const upstreamId = `up-${randomUUID()}`;
    const jobId = await seedConfigJob(upstreamId);

    const rawBody = JSON.stringify({ upstreamJobId: upstreamId, status: 'succeeded' });
    const sig = createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('hex');

    // A valid signature, but under the actionow default header — the channel's
    // config renamed it, so the verifier looks for CONFIG_SIGNATURE_HEADER only.
    const res = await postWithHeader(rawBody, SIGNATURE_HEADER, sig);
    expect(res.status).toBe(401);
    expect(await settleRows(jobId)).toHaveLength(0);
  });
});
