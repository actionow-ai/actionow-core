import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterRegistry } from '@actionow/adapters';
import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';
import { createApiKey, schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';

const { account, pricebookEntry, resource, resourceVersion, tenant, upstreamChannel } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('blocking path must not enqueue')),
};

const fakeLlm: ProviderAdapter = {
  providerType: 'fake-llm',
  submit(input: SubmitInput): Promise<SubmitResult> {
    return Promise.resolve({
      kind: 'sync',
      output: { text: `echo: ${String(input.inputs.prompt)}` },
      usage: { tokens: 1 },
    });
  },
  extractUsage(): UsageVector {
    return {};
  },
  mapError(): UnifiedError {
    return { code: 'upstream_error', message: 'fake', retryable: false };
  },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const adapters = new AdapterRegistry();
  adapters.register(fakeLlm);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ADAPTERS)
    .useValue(adapters)
    .overrideProvider(JOB_QUEUE)
    .useValue(noopQueue)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      // Generous tenant bucket; a tight resource bucket so we can trip it fast.
      RATE_LIMIT_TENANT_PER_MIN: 1000,
      RATE_LIMIT_RESOURCE_PER_MIN: 1000,
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

async function seedResource(resourceId: string): Promise<{ tenantId: string }> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  await db.insert(account).values({ tenantId: t.id, creditBalance: 1_000_000n, creditHeld: 0n });
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'fake-llm',
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(resourceVersion).values({
    resourceId,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string' }],
    },
  });
  await db.insert(pricebookEntry).values({
    resourceId,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
    active: true,
  });
  await db.insert(upstreamChannel).values({
    resourceId,
    providerType: 'fake-llm',
    weight: 1,
    status: 'active',
  });
  return { tenantId: t.id };
}

afterEach(async () => {
  await client`TRUNCATE TABLE api_key, webhook_outbox, ledger_txn, idempotency_key, job, pricebook_entry, upstream_channel, resource_version, resource, account, tenant RESTART IDENTITY CASCADE`;
});

describe('rate limiting on POST /v1/run', () => {
  it('429 rate_limited + retry_after_ms once the key rateLimit is exceeded', async () => {
    const s = await seedResource('openai-gpt');
    // The key carries its own per-resource budget of 2 requests/min.
    const { plaintext } = await createApiKey(db, { tenantId: s.tenantId, rateLimit: 2 });

    const send = (): request.Test =>
      request(app.getHttpServer())
        .post('/v1/run/openai-gpt')
        .set('authorization', `Bearer ${plaintext}`)
        .send({ inputs: { prompt: 'hi' }, estimated_usage: { tokens: 10 } });

    await send().expect(200);
    await send().expect(200);

    const blocked = await send().expect(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.retryable).toBe(true);
    expect(blocked.body.error.retry_after_ms).toBeGreaterThan(0);
  });
});
