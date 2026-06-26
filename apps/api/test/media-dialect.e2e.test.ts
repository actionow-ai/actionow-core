import { createDefaultRegistry, type ProviderAdapter } from '@actionow/adapters';
import {
  type AdapterContext,
  type PollResult,
  type SubmitResult,
  type UnifiedError,
  type UsageVector,
} from '@actionow/contracts';
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
import { seedProviders } from '../src/seed/seed-providers.js';

/**
 * Phase 4b — OpenAI media-dialect e2e. Boots a REAL HTTP server so the binary
 * audio response streams over the wire. The seeded `image-relay`/`audio-relay`
 * resources use the generic `async-media` provider, OVERRIDDEN here with a FAKE
 * adapter whose submit→poll returns a canned succeeded result (an https image url
 * for the image model, a `data:` audio url for the tts model — global fetch reads
 * both, so the test needs no upstream network or storage). The dialect drives the
 * async job to terminal in-process and maps the output to the OpenAI shape.
 */

const IMAGE_URL = 'https://cdn.relay.example/generated.png';
// "Hello" as base64 → a data: url global fetch decodes to bytes, no network.
const AUDIO_DATA_URL = 'data:audio/mpeg;base64,SGVsbG8=';

/** A fake `async-media` adapter: submit returns a handle; poll returns succeeded. */
const fakeAsyncMedia: ProviderAdapter = {
  providerType: 'async-media',
  submit: (): Promise<SubmitResult> =>
    Promise.resolve({ kind: 'async', provider: 'async-media', upstreamJobId: 'task-1', meta: {} }),
  poll: (_id: string, ctx: AdapterContext): Promise<PollResult> => {
    const model = ctx.model ?? '';
    if (model.includes('tts') || model.includes('audio')) {
      return Promise.resolve({
        status: 'succeeded',
        output: { audio_url: AUDIO_DATA_URL, character_count: 5 },
        usage: { characters: 5 },
      });
    }
    return Promise.resolve({
      status: 'succeeded',
      output: { image_url: IMAGE_URL, image_count: 1 },
      usage: { images: 1 },
    });
  },
  extractUsage: (): UsageVector => ({ tasks: 1 }),
  mapError: (): UnifiedError => ({
    code: 'job_failed',
    message: 'fake',
    upstream: { provider: 'async-media' },
    retryable: false,
  }),
};

let pg: StartedPostgreSqlContainer | undefined;
let db: Database;
let app: INestApplication | undefined;
let baseUrl: string;
let tenantId: string;
let apiKey: string;

const noopQueue = { enqueueExec: (): Promise<void> => Promise.resolve() };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected object');
  return value as Record<string, unknown>;
}

async function settleRows(jobId: string): Promise<(typeof schema.ledgerTxn.$inferSelect)[]> {
  const rows = await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId));
  return rows.filter((l) => l.type === 'settle');
}

async function latestJob(resourceId: string): Promise<typeof schema.job.$inferSelect | undefined> {
  const jobs = await db.select().from(schema.job).where(eq(schema.job.resourceId, resourceId));
  return jobs
    .filter((j) => j.status === 'succeeded')
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
    ADMIN_JWT_SECRET: 'p4b-admin-secret',
    STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    CREDIT_RATE: 1000,
    ALLOW_DEV_TENANT_HEADER: false,
    RELAY_TRACE: 'off',
    RELAY_TRACE_MAX_BYTES: 1_000_000,
  };

  const adapters = createDefaultRegistry();
  adapters.register(fakeAsyncMedia); // override the real async-media with the fake

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
    // The breaker (弹性2.0) over a fake Redis (no real Redis in this suite); it is
    // fail-open so even a no-op would not break routing, but a fake keeps it hermetic.
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
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  const [t] = await db.insert(schema.tenant).values({ name: 'p4b' }).returning();
  if (!t) throw new Error('no tenant');
  tenantId = t.id;
  await db
    .insert(schema.account)
    .values({ tenantId, creditBalance: creditsToMicro(100), creditHeld: 0n });
  const key = await createApiKey(db, { tenantId });
  apiKey = key.plaintext;

  // Seed image-relay + audio-relay (+ the rest) under this tenant.
  await seedProviders(db, { tenantId });
}, 180_000);

afterAll(async () => {
  if (app !== undefined) await app.close();
  if (pg !== undefined) await pg.stop();
});

describe('OpenAI image dialect (POST /v1/images/generations)', () => {
  it('relays image-relay synchronously → 200 {data:[{url}]}, settled once', async () => {
    const res = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a red bicycle on a beach' }),
    });
    expect(res.status).toBe(200);
    const body = asRecord(await res.json());
    expect(typeof body.created).toBe('number');
    const data = body.data as Record<string, unknown>[];
    expect(data).toHaveLength(1);
    expect(data[0]?.url).toBe(IMAGE_URL);

    const job = await latestJob('image-relay');
    expect(job).toBeDefined();
    const settles = await settleRows(job?.id ?? '');
    expect(settles).toHaveLength(1); // driven to terminal exactly once
    expect(job?.costCredits).toBe(250_000n); // 1 image × 250_000 µcredits
  });

  it('rejects a missing prompt with 400 invalid_input', async () => {
    const res = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1' }),
    });
    expect(res.status).toBe(400);
    expect(asRecord(asRecord(await res.json()).error).code).toBe('invalid_input');
  });

  it('401 without an API key', async () => {
    const res = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('OpenAI audio dialect (POST /v1/audio/speech)', () => {
  it('relays audio-relay synchronously → 200 binary audio bytes, settled once', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: 'hello', voice: 'alloy' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf)).toBe('Hello'); // decoded from the data: url

    const job = await latestJob('audio-relay');
    expect(job).toBeDefined();
    const settles = await settleRows(job?.id ?? '');
    expect(settles).toHaveLength(1);
    expect(job?.costCredits).toBe(2_500n); // 5 characters × 500 µcredits
  });

  it('accepts response_format + speed without a 400 (io_schema declares them)', async () => {
    // Regression: the dialect builds run inputs { prompt, voice, format, speed };
    // the strict audio-relay io_schema MUST declare `format`/`speed` or
    // validateInputs rejects the run with 400 invalid_input ("Unrecognized
    // key(s) in object: 'format'"). A 200 here proves the schema fix took.
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1',
        input: 'hello',
        voice: 'alloy',
        response_format: 'mp3',
        speed: 1.25,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf)).toBe('Hello');
  });
});
