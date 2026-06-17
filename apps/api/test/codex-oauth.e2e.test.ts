import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDefaultRegistry } from '@actionow/adapters';
import {
  createApiKey,
  createDb,
  createModel,
  createOAuthSession,
  type Database,
  schema,
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
 * Task S3.10 — full codex-oauth relay e2e against a FAKE local upstream.
 *
 * This proves the WHOLE relay end-to-end: an OpenAI-dialect `/v1/chat/completions`
 * request → the REAL chat relay (real model resolver, real engine settling) → the
 * REAL `codex-oauth` adapter (registered in `createDefaultRegistry`) → a local fake
 * "codex responses" HTTP server. The adapter POSTs to
 * `${ctx.endpoint}/responses`, so the seeded channel's `endpoint` points at the
 * fake server's base and we NEVER hit the real `chatgpt.com`.
 *
 * The fake server ASSERTS the real impersonation + token attach + IR→Responses
 * translation: `Authorization: Bearer <oauth access token>`, `Originator:
 * codex_cli_rs`, `Chatgpt-Account-Id: <acct>`, `OpenAI-Beta: responses=experimental`,
 * a `codex_cli_rs` User-Agent, and a Responses-shaped body (`store:false`, system
 * hoisted to `instructions`, an `input` array with NO system role). The codex
 * backend is stream-only, so it returns a canned Responses SSE stream, which the
 * relay's `chat()` aggregates back into an OpenAI `chat.completion`. We then
 * assert settle-once, a `usage_log` row tagged `provider_type='codex-oauth'`,
 * and the `x-actionow-channel: codex-oauth` header.
 *
 * The oauth access token decrypts because `SECRET_ENCRYPTION_KEY` is set both in
 * the ENV override AND on `process.env` (the `oauth` branch of `resolveSecretRef`
 * reads it from `process.env`).
 */

/** The seeded chat resource id (provider `codex-oauth`, stream + blocking). */
const CHAT_RESOURCE = 'chat-codex-resource';
/** The seeded public model name the caller sends in the request body. */
const MODEL_NAME = 'my-codex';
/** µcredit-per-input-token (resale price) seeded on the model. */
const INPUT_PRICE = 3n;
/** µcredit-per-output-token (resale price) seeded on the model. */
const OUTPUT_PRICE = 7n;
/** The canned fake-upstream usage (Responses `usage` block). */
const UPSTREAM_INPUT_TOKENS = 11n;
const UPSTREAM_OUTPUT_TOKENS = 4n;
/** Expected model_token settle cost: input*inputPrice + output*outputPrice. */
const EXPECTED_COST = UPSTREAM_INPUT_TOKENS * INPUT_PRICE + UPSTREAM_OUTPUT_TOKENS * OUTPUT_PRICE;
/** The live oauth access token the fake upstream must see attached. */
const OAUTH_ACCESS = 'oat-live';
/** The ChatGPT account id the channel impersonates. */
const ACCOUNT_ID = 'acct_codex_1';
/** Base64 AES-256 master key used to encrypt the seeded oauth tokens. */
const KEY = randomBytes(32).toString('base64');

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;

/** A no-op queue: chat paths run blocking/stream, never enqueue. */
const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

/** What the fake upstream saw on the single relayed request. */
interface SeenRequest {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
let seen: SeenRequest | undefined;

/** The fake "codex responses" upstream server. */
let upstream: Server | undefined;
/** The fake upstream base passed to the channel (`/responses` is appended by the adapter). */
let fakeBase: string;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
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

/** Read a request body fully into a string. */
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

/**
 * Canned OpenAI **Responses SSE** stream the fake upstream emits.
 *
 * The codex backend is stream-only, so the adapter's `chat()` requests an SSE
 * stream (`stream:true` + `Accept: text/event-stream`) and aggregates it. These
 * frames are the streaming equivalent of the old non-stream reply: two
 * `output_text.delta`s that concatenate to `'hi from codex'`, then a
 * `response.completed` carrying the same `usage` + a `completed` status.
 */
const CANNED_SSE_FRAMES = [
  'event: response.created\ndata: {"type":"response.created"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi from "}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"codex"}\n\n',
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: {
      status: 'completed',
      usage: {
        input_tokens: Number(UPSTREAM_INPUT_TOKENS),
        output_tokens: Number(UPSTREAM_OUTPUT_TOKENS),
      },
    },
  })}\n\n`,
];

beforeAll(async () => {
  // Stand up the fake "codex responses" upstream. The adapter POSTs to
  // `${endpoint}/responses`, so the channel's endpoint is `<fakeBase>` and the
  // path lands here as `/backend-api/codex/responses`.
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req);
      seen = { headers: req.headers, body: asRecord(JSON.parse(raw)) };
      // The codex backend is stream-only: respond with an SSE stream of
      // Responses events, which the relay's chat() aggregates back into a
      // chat.completion.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of CANNED_SSE_FRAMES) {
        res.write(frame);
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
  const port = String((upstream.address() as AddressInfo).port);
  fakeBase = `http://127.0.0.1:${port}/backend-api/codex`;

  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pgUri = pg.getConnectionUri();
  db = createDb(pgUri);
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  // The `oauth` branch of `resolveSecretRef` reads SECRET_ENCRYPTION_KEY from
  // process.env to decrypt the oauth access token → ctx.apiKey.
  process.env.SECRET_ENCRYPTION_KEY = KEY;

  const env: AppEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: pgUri,
    REDIS_URL: 'redis://localhost:6379',
    API_PORT: 0,
    LOG_LEVEL: 'info',
    RATE_LIMIT_TENANT_PER_MIN: 600,
    RATE_LIMIT_RESOURCE_PER_MIN: 600,
    ADMIN_JWT_SECRET: 'codex-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    SECRET_ENCRYPTION_KEY: KEY,
  };

  // The default registry now includes the REAL `codex-oauth` adapter (S2.6b).
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
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  // Tenant + funded account + api key.
  const [t] = await db.insert(schema.tenant).values({ name: 'codex-tenant' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;

  // Encrypted oauth session → its secret_ref id is the channel's credentialRef.
  const ref = await createOAuthSession(db, {
    providerKind: 'codex-oauth',
    accessToken: OAUTH_ACCESS,
    refreshToken: 'oat-ref',
    accountId: ACCOUNT_ID,
    keyB64: KEY,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const secretRefId = ref.id;

  // Chat resource: provider `codex-oauth`, stream + blocking, io_schema with NO
  // required inputs (the `__ir` passthrough is stripped before validation).
  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId,
    kind: 'model',
    modality: 'chat',
    providerType: 'codex-oauth',
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [{ key: '__ir', type: 'json' }] },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId: CHAT_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing: 'post',
    spec: {
      method: 'model_token',
      inputPrice: Number(INPUT_PRICE),
      outputPrice: Number(OUTPUT_PRICE),
    },
    active: true,
  });
  // The codex-oauth channel: credentials via the encrypted oauth session, the
  // account id forwarded as `config.chatgptAccountId`, and the endpoint pointed
  // at the local fake upstream so no real network call is made.
  await db.insert(schema.upstreamChannel).values({
    resourceId: CHAT_RESOURCE,
    providerType: 'codex-oauth',
    credentialRef: secretRefId,
    config: { chatgptAccountId: ACCOUNT_ID },
    endpoint: fakeBase,
    weight: 1,
    status: 'active',
  });

  // A real, public, active model row → the REAL MODEL_RESOLVER returns it; the
  // relay prices the settle off its input/output prices (model_token).
  await createModel(db, {
    name: MODEL_NAME,
    resourceId: CHAT_RESOURCE,
    display: 'My Codex',
    modality: 'chat',
    capabilities: { tools: true, vision: true, audio: false, json: true, stream: true },
    visibility: 'public',
    inputPrice: INPUT_PRICE,
    outputPrice: OUTPUT_PRICE,
    status: 'active',
  });
}, 120_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (upstream !== undefined)
    await new Promise<void>((r) =>
      upstream?.close(() => {
        r();
      }),
    );
  if (pg !== undefined) await pg.stop();
  delete process.env.SECRET_ENCRYPTION_KEY;
});

describe('codex-oauth relay e2e (OpenAI dialect over a fake upstream)', () => {
  it('relays /v1/chat/completions through the real codex-oauth adapter', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
      }),
    });

    // ── The relay returned a normal OpenAI chat.completion from the canned reply.
    expect(res.status).toBe(200);
    expect(res.headers.get('x-actionow-channel')).toBe('codex-oauth');
    const body = asRecord(await res.json());
    expect(body.object).toBe('chat.completion');
    const choice = asRecord((body.choices as unknown[])[0]);
    expect(asRecord(choice.message).content).toContain('hi from codex');

    // ── The fake upstream saw exactly the real impersonation + token attach.
    expect(seen).toBeDefined();
    const headers = seen?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${OAUTH_ACCESS}`);
    expect(headers['chatgpt-account-id']).toBe(ACCOUNT_ID);
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['openai-beta']).toBe('responses=experimental');
    expect(String(headers['user-agent'])).toContain('codex_cli_rs');

    // ── And a Responses-shaped body: store:false, system → instructions, an
    //    `input` array carrying the user turn but NO system role.
    const reqBody = seen?.body ?? {};
    expect(reqBody.store).toBe(false);
    expect(reqBody.instructions).toBe('be brief');
    const input = reqBody.input as Record<string, unknown>[];
    expect(Array.isArray(input)).toBe(true);
    expect(input.every((item) => asRecord(item).role !== 'system')).toBe(true);
    const userItem = input.find((item) => asRecord(item).role === 'user');
    expect(userItem).toBeDefined();

    // ── Exactly one settle ledger row, priced off the model's 3/7 catalog.
    const job = await latestChatJob();
    expect(job).toBeDefined();
    const rows = await settleRows(job?.id ?? '');
    expect(rows).toHaveLength(1);
    // model_token cost: 11*3 + 4*7 = 61µ.
    expect(rows[0]?.creditsDelta).toBe(-EXPECTED_COST);
    expect(job?.costCredits).toBe(EXPECTED_COST);

    // ── A usage_log row tagged with the serving channel's provider type.
    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    const log = logs.find((l) => l.model === MODEL_NAME);
    expect(log).toBeDefined();
    expect(log?.providerType).toBe('codex-oauth');
    expect(log?.inputTokens).toBe(Number(UPSTREAM_INPUT_TOKENS));
    expect(log?.outputTokens).toBe(Number(UPSTREAM_OUTPUT_TOKENS));
    expect(log?.cost).toBe(EXPECTED_COST);
  });
});
