import { createDefaultRegistry } from '@actionow/adapters';
import { createApiKey, createDb, type Database, schema } from '@actionow/db';
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
 * STT-relay e2e (`POST /v1/audio/transcriptions`). Boots a REAL HTTP server and
 * relays onto the `mock-chat` adapter's `transcribe`, which returns a fixed
 * transcript `'hello world'` + a byte-derived duration (`ceil(bytes / 1000)`,
 * floored at 1). The relay routes onto the seeded `stt-relay` resource (provider
 * `mock-chat`, blocking), sizes a REAL audio-duration hold from the upload bytes,
 * and settles on the adapter-reported `audio_seconds` via the resource's
 * `unit/post` pricebook (charged per second). `usageLogModel` is set so a
 * `usage_log` row is mirrored.
 */

/** The seeded STT resource id the controller routes onto (must match SttRelayService.STT_RESOURCE). */
const STT_RESOURCE = 'stt-relay';
/** µcredits per second of transcribed audio in the seeded pricebook. */
const RATE_PER_SECOND = 100n;
/** The mock's bytes-per-second divisor (mock-chat MOCK_TRANSCRIBE_BYTES_PER_SECOND). */
const MOCK_BYTES_PER_SECOND = 1000;

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;
let apiKeyId: string;

/** A no-op queue: STT runs blocking, never enqueues. */
const noopQueue = {
  enqueueExec: (): Promise<void> => Promise.reject(new Error('must not enqueue')),
};

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

/** The newest succeeded STT job (newest first). */
async function latestSttJob(): Promise<typeof schema.job.$inferSelect | undefined> {
  const jobs = await db.select().from(schema.job).where(eq(schema.job.resourceId, STT_RESOURCE));
  return jobs
    .filter((j) => j.status === 'succeeded')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/** Build a multipart body with an audio `file` part + the given text fields. */
function audioForm(
  bytes: Uint8Array,
  fields: Record<string, string>,
  filename = 'clip.mp3',
): FormData {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so Blob accepts it as a BlobPart.
  const part = new Uint8Array(bytes.byteLength);
  part.set(bytes);
  const blob = new Blob([part], { type: 'audio/mpeg' });
  form.append('file', blob, filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
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
    ADMIN_JWT_SECRET: 'stt-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
    // A small STT upload limit so the oversize-rejection test stays fast.
    STT_MAX_UPLOAD_BYTES: 50_000,
    // Hold divisor < the mock's 1000 B/s duration ratio, so the byte-based hold
    // OVER-estimates the mock's reported duration (the real-world case for ≥128
    // kbps audio) — the settle then re-prices DOWN to the actual seconds, exercising
    // the refund-the-overage path rather than the cap-at-hold clamp.
    STT_HOLD_BYTES_PER_SECOND: 500,
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

  const [t] = await db.insert(schema.tenant).values({ name: 'stt-tenant' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;
  apiKeyId = key.id;

  // STT resource: provider `mock-chat`, blocking, EMPTY io_schema (the `__ir`
  // passthrough is stripped before validation). GLOBAL (tenant_id null) so any
  // tenant can run it (mirrors the real seed).
  await db.insert(schema.resource).values({
    id: STT_RESOURCE,
    tenantId: null,
    kind: 'model',
    modality: 'audio',
    providerType: 'mock-chat',
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: STT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [] },
  });
  // unit/post pricebook charging the `audio_seconds` dimension (100 µcredits/s).
  await db.insert(schema.pricebookEntry).values({
    resourceId: STT_RESOURCE,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { audio_seconds: { rate: Number(RATE_PER_SECOND) } } },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId: STT_RESOURCE,
    providerType: 'mock-chat',
    model: 'whisper-1',
    weight: 1,
    status: 'active',
  });
}, 120_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('OpenAI speech-to-text (/v1/audio/transcriptions)', () => {
  it('multipart upload → 200 {text}, settle-once on the actual audio_seconds, usage_log', async () => {
    // 2500 bytes / 1000 (mock divisor) → 3 audio seconds → 3 × 100 = 300µ.
    const bytes = new Uint8Array(2500);
    const expectedSeconds = Math.max(1, Math.ceil(bytes.length / MOCK_BYTES_PER_SECOND));
    const expectedCost = BigInt(expectedSeconds) * RATE_PER_SECOND;

    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: audioForm(bytes, { model: 'whisper-1' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-actionow-channel')).toBe('mock-chat');
    const body = asRecord(await res.json());
    expect(body.text).toBe('hello world');
    // default `json` format → just the transcript text (no language/duration).
    expect(body.language).toBeUndefined();
    expect(body.duration).toBeUndefined();

    const job = await latestSttJob();
    expect(job).toBeDefined();
    const rows = await settleRows(job?.id ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-expectedCost);
    expect(job?.costCredits).toBe(expectedCost);

    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, tenantId));
    const log = logs.find((l) => l.model === 'whisper-1');
    expect(log).toBeDefined();
    expect(log?.cost).toBe(expectedCost);
    expect(log?.apiKeyId).toBe(apiKeyId);
  });

  it('response_format=verbose_json → {text, language, duration, segments}', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: audioForm(new Uint8Array(1500), {
        model: 'whisper-1',
        response_format: 'verbose_json',
      }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(body.text).toBe('hello world');
    expect(body.language).toBe('en');
    expect(typeof body.duration).toBe('number');
    expect(Array.isArray(body.segments)).toBe(true);
  });

  it('response_format=text → the raw transcript string', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: audioForm(new Uint8Array(1500), { model: 'whisper-1', response_format: 'text' }),
    });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe('hello world');
  });

  it('missing the model field → 400 invalid_input', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: audioForm(new Uint8Array(1000), {}),
    });
    expect(res.status).toBe(400);
    expect(asRecord(asRecord(await res.json()).error).code).toBe('invalid_input');
  });

  it('missing the file part → 400 invalid_input', async () => {
    const form = new FormData();
    form.append('model', 'whisper-1');
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(asRecord(asRecord(await res.json()).error).code).toBe('invalid_input');
  });

  it('oversize upload → 400 invalid_input', async () => {
    // 60_000 bytes > the 50_000-byte STT_MAX_UPLOAD_BYTES configured above.
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: audioForm(new Uint8Array(60_000), { model: 'whisper-1' }),
    });
    expect(res.status).toBe(400);
    expect(asRecord(asRecord(await res.json()).error).code).toBe('invalid_input');
  });

  it('missing api key → 401 unauthorized', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: audioForm(new Uint8Array(1000), { model: 'whisper-1' }),
    });
    expect(res.status).toBe(401);
  });

  it('insufficient credits → 402 insufficient_credits', async () => {
    const [poorTenant] = await db.insert(schema.tenant).values({ name: 'stt-broke' }).returning();
    if (!poorTenant) throw new Error('no tenant');
    await db
      .insert(schema.account)
      .values({ tenantId: poorTenant.id, creditBalance: 0n, creditHeld: 0n });
    const poorKey = await createApiKey(db, { tenantId: poorTenant.id });

    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${poorKey.plaintext}` },
      body: audioForm(new Uint8Array(2000), { model: 'whisper-1' }),
    });
    expect(res.status).toBe(402);
    expect(asRecord(asRecord(await res.json()).error).code).toBe('insufficient_credits');
  });

  it('replays the original STT job on a repeated Idempotency-Key (no double charge)', async () => {
    const idemKey = 'stt-idem-key-1';
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idemKey },
        body: audioForm(new Uint8Array(2000), { model: 'whisper-1' }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = asRecord(await first.json());

    const second = await send();
    expect(second.status).toBe(200);
    const secondBody = asRecord(await second.json());
    expect(secondBody.text).toEqual(firstBody.text);

    const jobs = await db.select().from(schema.job).where(eq(schema.job.idempotencyKey, idemKey));
    expect(jobs).toHaveLength(1);
    expect(await settleRows(jobs[0]?.id ?? '')).toHaveLength(1);
  });
});
