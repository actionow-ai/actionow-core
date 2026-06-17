import { AdapterRegistry, createAsyncMediaMock } from '@actionow/adapters';
import type { HttpClient, StorageProvider } from '@actionow/contracts';
import {
  createJob,
  createOAuthSession,
  getDecryptedOAuthSession,
  getJob,
  holdCredits,
  type Job,
  schema,
} from '@actionow/db';
import type { FetchBytes, PutBytes } from '@actionow/engine';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createHoldReaperProcessor,
  createJobExecProcessor,
  createTokenRefreshProcessor,
  createWebhookOutboxProcessor,
} from '../src/processors/index.js';
import type { WorkerRuntime } from '../src/runtime.js';

const {
  account,
  fileObject,
  ledgerTxn,
  oauthSession,
  pricebookEntry,
  resource,
  resourceVersion,
  tenant,
  upstreamChannel,
  webhookOutbox,
} = schema;

/** Base64 AES-256 master key the token-refresh sweep encrypts/decrypts with. */
const KEY = Buffer.alloc(32, 9).toString('base64');

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE oauth_session, secret_ref, file_object, webhook_outbox, ledger_txn, idempotency_key, job, pricebook_entry, upstream_channel, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

const noHttp: HttpClient = { request: () => Promise.reject(new Error('no http')) };
// Default byte fns reject — the network-free suite never persists unless a test
// configures storage + publicBaseUrl AND overrides these.
const noFetchBytes: FetchBytes = () => Promise.reject(new Error('no fetchBytes'));
const noPutBytes: PutBytes = () => Promise.reject(new Error('no putBytes'));

function runtimeWith(adapters: AdapterRegistry, http: HttpClient = noHttp): WorkerRuntime {
  return {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: 'test-secret',
      STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
      CREDIT_RATE: 1000,
      ALLOW_DEV_TENANT_HEADER: false,
      SECRET_ENCRYPTION_KEY: KEY,
    },
    db,
    adapters,
    http,
    resolveSecret: () => Promise.resolve(undefined),
    storage: null,
    publicBaseUrl: undefined,
    fetchBytes: noFetchBytes,
    putBytes: noPutBytes,
  };
}

interface Seed {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

async function seed(balance: bigint): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const resourceId = 'mock-image';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'image',
    providerType: 'async-media-mock',
    execModes: ['async-poll'],
  });
  await db
    .insert(resourceVersion)
    .values({ resourceId, version: 1, ioSchema: { inputs: [], outputs: [] } });
  await db.insert(pricebookEntry).values({
    resourceId,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { images: { rate: 100 } } },
    active: true,
  });
  await db.insert(upstreamChannel).values({
    resourceId,
    providerType: 'async-media-mock',
    weight: 1,
    status: 'active',
  });
  return { tenantId: t.id, accountId: a.id, resourceId };
}

async function makeQueuedJob(s: Seed, hold: bigint, holdExpiresAt?: Date): Promise<Job> {
  const ok = await holdCredits(db, s.accountId, hold);
  if (!ok) throw new Error('hold failed in fixture');
  return createJob(db, {
    tenantId: s.tenantId,
    resourceId: s.resourceId,
    resourceVersion: 1,
    execMode: 'async-poll',
    inputs: { prompt: 'a cat' },
    quotedCredits: hold,
    holdExpiresAt: holdExpiresAt ?? null,
  });
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

describe('job-exec processor', () => {
  it('drives a queued async job to succeeded and settles the ledger', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 0 }));
    const process = createJobExecProcessor(runtimeWith(adapters));

    await process({ jobId: job.id });

    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');
    expect(settled?.costCredits).toBe(100n);
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_900n, held: 0n });
    const settleRows = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, job.id))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
  });

  it('passes channel endpoint + model into the adapter context on the async path', async () => {
    const s = await seed(1_000_000n);
    // Point the resource + channel at a capturing adapter, with per-channel
    // endpoint + model set on the row.
    await client`UPDATE upstream_channel SET endpoint='https://api.deepseek.com/v1', model='deepseek-chat', provider_type='capture' WHERE resource_id=${s.resourceId}`;
    await client`UPDATE resource SET provider_type='capture' WHERE id=${s.resourceId}`;

    const seen: { endpoint: string | undefined; model: string | undefined }[] = [];
    const adapters = new AdapterRegistry();
    adapters.register({
      providerType: 'capture',
      submit: (i) => {
        seen.push({ endpoint: i.ctx.endpoint, model: i.ctx.model });
        return Promise.resolve({ kind: 'async', provider: 'capture', upstreamJobId: 'u1' });
      },
      poll: () =>
        Promise.resolve({ status: 'succeeded', output: { text: 'ok' }, usage: { images: 1 } }),
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
    });

    const job = await makeQueuedJob(s, 1_000n);
    const process = createJobExecProcessor(runtimeWith(adapters));
    await process({ jobId: job.id });

    expect(seen[0]).toEqual({ endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  });

  it('persists async media output to storage and rewrites the public URL', async () => {
    const s = await seed(1_000_000n);
    await client`UPDATE resource SET modality='image' WHERE id=${s.resourceId}`;
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 0 }));

    const puts: string[] = [];
    const storage: StorageProvider = {
      kind: 'r2',
      presignPut: (key) => {
        puts.push(key);
        return Promise.resolve({ url: `https://r2.local/${key}`, key, expiresIn: 900 });
      },
      presignGet: (key) => Promise.resolve({ url: `https://r2.local/${key}`, expiresIn: 3600 }),
      head: () => Promise.resolve({ exists: true }),
      delete: () => Promise.resolve(),
    };
    const putUrls: string[] = [];
    const rt = runtimeWith(adapters);
    rt.storage = storage;
    rt.publicBaseUrl = 'https://asset.actionow.ai';
    rt.fetchBytes = () =>
      Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
    rt.putBytes = (url) => {
      putUrls.push(url);
      return Promise.resolve();
    };
    const process = createJobExecProcessor(rt);

    await process({ jobId: job.id });

    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');
    expect((settled?.output as Record<string, unknown>).image_url).toContain(
      'https://asset.actionow.ai/',
    );
    expect(puts).toHaveLength(1);
    const key = puts[0];
    if (key === undefined) throw new Error('no presigned key captured');
    expect(key).toBe(`${s.tenantId}/${job.id}.png`);
    expect(putUrls).toEqual([`https://r2.local/${key}`]);
  });

  it('records a ready file_object for each persisted media object', async () => {
    const s = await seed(1_000_000n);
    await client`UPDATE resource SET modality='image' WHERE id=${s.resourceId}`;
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 0 }));

    const storage: StorageProvider = {
      kind: 'r2',
      presignPut: (key) => Promise.resolve({ url: `https://r2.local/${key}`, key, expiresIn: 900 }),
      presignGet: (key) => Promise.resolve({ url: `https://r2.local/${key}`, expiresIn: 3600 }),
      head: () => Promise.resolve({ exists: true }),
      delete: () => Promise.resolve(),
    };
    const rt = runtimeWith(adapters);
    rt.storage = storage;
    rt.publicBaseUrl = 'https://asset.actionow.ai';
    rt.fetchBytes = () =>
      Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
    rt.putBytes = () => Promise.resolve();
    const process = createJobExecProcessor(rt);

    await process({ jobId: job.id });

    const files = await db.select().from(fileObject).where(eq(fileObject.tenantId, s.tenantId));
    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe('ready');
    expect(files[0]?.key).toBe(`${s.tenantId}/${job.id}.png`);
    expect(files[0]?.size).toBe(3);
    expect(files[0]?.contentType).toBe('image/png');
    expect(files[0]?.provider).toBe('r2');
  });
});

describe('hold-reaper processor', () => {
  it('cancels an expired in-flight job and releases its hold', async () => {
    const s = await seed(1_000_000n);
    const past = new Date(Date.now() - 60_000);
    const job = await makeQueuedJob(s, 1_000n, past);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 1_000n });
    const process = createHoldReaperProcessor(runtimeWith(new AdapterRegistry()));

    const reaped = await process();

    expect(reaped).toBe(1);
    const after = await getJob(db, job.id);
    expect(after?.status).toBe('canceled');
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
  });
});

describe('webhook-outbox processor', () => {
  it('delivers a due webhook and marks it sent', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    // Seed an explicit past due-time so the row is unambiguously due regardless
    // of Postgres-container-vs-host clock skew (defaultNow() uses the container
    // clock; the processor queries with the host clock). Mirrors the hold-reaper
    // test's `new Date(Date.now() - 60_000)`.
    await db.insert(webhookOutbox).values({
      jobId: job.id,
      url: 'https://hook.example/cb',
      payload: { job_id: job.id },
      nextAttemptAt: new Date(Date.now() - 60_000),
    });

    const calls: { url: string }[] = [];
    const http: HttpClient = {
      request: (req) => {
        calls.push({ url: req.url });
        return Promise.resolve({ status: 200, ok: true, body: {}, text: 'ok' });
      },
    };
    const process = createWebhookOutboxProcessor(runtimeWith(new AdapterRegistry(), http));

    const summary = await process();

    expect(summary.sent).toBe(1);
    expect(calls).toEqual([{ url: 'https://hook.example/cb' }]);
    const [row] = await db.select().from(webhookOutbox).where(eq(webhookOutbox.jobId, job.id));
    expect(row?.status).toBe('sent');
  });
});

/** A mock http that returns a Codex token response for the codex token endpoint. */
function codexTokenHttp(res: { status: number; ok: boolean; body: unknown; text: string }): {
  http: HttpClient;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  const http: HttpClient = {
    request: (req) => {
      calls.push({ url: req.url });
      return Promise.resolve(res);
    },
  };
  return { http, calls };
}

describe('token-refresh processor', () => {
  it('rotates a near-expiry codex session, advances expiry, clears the lock', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'old',
      refreshToken: 'rt-1',
      keyB64: KEY,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { http, calls } = codexTokenHttp({
      status: 200,
      ok: true,
      body: { access_token: 'new', refresh_token: 'rt-2', id_token: 'id.jwt.x', expires_in: 3600 },
      text: 'ok',
    });
    const process = createTokenRefreshProcessor(runtimeWith(new AdapterRegistry(), http));

    const refreshed = await process();

    expect(refreshed).toBe(1);
    expect(calls).toHaveLength(1);
    const after = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(after?.accessToken).toBe('new');
    expect(after?.refreshToken).toBe('rt-2');
    // Expiry advanced to ~now + 3600s, well past the original now+60s.
    expect(after?.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now() + 60 * 60_000 - 60_000);
    const [row] = await db.select().from(oauthSession).where(eq(oauthSession.secretRefId, ref.id));
    expect(row?.refreshLockAt).toBeNull();
  });

  it('does NOT refresh a session whose expiry is far in the future', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'old',
      refreshToken: 'rt-1',
      keyB64: KEY,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    const { http, calls } = codexTokenHttp({
      status: 200,
      ok: true,
      body: { access_token: 'new', refresh_token: 'rt-2', expires_in: 3600 },
      text: 'ok',
    });
    const process = createTokenRefreshProcessor(runtimeWith(new AdapterRegistry(), http));

    const refreshed = await process();

    expect(refreshed).toBe(0);
    expect(calls).toHaveLength(0);
    const after = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(after?.accessToken).toBe('old');
  });

  it('marks a session needs_reauth when the refresh token was reused', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'old',
      refreshToken: 'rt-1',
      keyB64: KEY,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { http } = codexTokenHttp({
      status: 400,
      ok: false,
      body: { error: 'invalid_grant', error_description: 'refresh_token_reused' },
      text: 'refresh_token_reused',
    });
    const process = createTokenRefreshProcessor(runtimeWith(new AdapterRegistry(), http));

    const refreshed = await process();

    expect(refreshed).toBe(0);
    const [row] = await db.select().from(oauthSession).where(eq(oauthSession.secretRefId, ref.id));
    expect(row?.status).toBe('needs_reauth');
    expect(row?.refreshLockAt).toBeNull();
    // Tokens untouched (still decrypts to the original).
    const after = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(after?.accessToken).toBe('old');
  });
});
