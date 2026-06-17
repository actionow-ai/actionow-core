import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterRegistry } from '@actionow/adapters';
import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';
import { createApiKey, createTenant, schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE, RATE_LIMITER } from '../src/common/tokens.js';
import { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, seedAll } from '../src/seed/seed.js';

/**
 * §12 acceptance e2e — proves the seed → `POST /v1/run` path end-to-end against a
 * Testcontainers postgres, with a stubbed adapter (deterministic `{text}`+usage,
 * no network) and an in-memory rate limiter (no live Redis). The seed's
 * `seedAll` provisions the fixtures; the stub provider type is injected so the
 * `openai`-style resource resolves to {@link fakeLlm}.
 */

const ADMIN_SECRET = 'e2e-admin-secret';
/** The provider type the seeded resource + the stub adapter share. */
const STUB_PROVIDER = 'fake-llm';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let apiKey: string;
let seedTenantId: string;

/** The §7.1 sample BYO workflow used by criterion 6 (dify import). */
const WORKFLOW_DSL = `
app: { mode: workflow, name: 小红书文案配图, icon: "🎨" }
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

/** Tokens the stub adapter always reports, so cost is deterministic. */
const STUB_TOKENS = 300;

/** A no-op queue: the blocking path never enqueues. */
const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('blocking path must not enqueue')),
};

/** A stubbed blocking LLM adapter — no network; fixed text + token usage. */
const fakeLlm: ProviderAdapter = {
  providerType: STUB_PROVIDER,
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

/**
 * A tiny per-(tenant,resource) limit carried by criterion 5's API key, so that
 * test trips after a couple of requests WITHOUT throttling the other criteria
 * (which run under the generous default below).
 */
const TINY_RESOURCE_LIMIT = 2;

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
      // production disables the x-tenant-id dev fallback, so a real API key is
      // required — exactly the surface §12 exercises.
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      // Generous defaults so criteria 1/3 are never throttled; criterion 5 trips
      // its own bucket via an API key that carries a tiny `rateLimit`.
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();

  // Run the seed against the test db, injecting the stub provider type so the
  // openai-style resource routes to fakeLlm (no network).
  const seeded = await seedAll(db, { providerType: STUB_PROVIDER });
  if (seeded.apiKey === null) throw new Error('seed did not mint an API key');
  apiKey = seeded.apiKey;
  seedTenantId = seeded.tenantId;
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

const SEED_RESOURCE = 'openai-gpt';

function bearer(req: request.Test, key = apiKey): request.Test {
  return req.set('authorization', `Bearer ${key}`);
}

async function adminToken(): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD })
    .expect(200);
  return res.body.token as string;
}

/**
 * Provision a complete runnable resource (resource + io_schema + unit/post
 * pricebook + active channel) owned by `tenantId`, routing to the stub adapter.
 */
async function provisionResource(tenantId: string, resourceId: string): Promise<void> {
  await db.insert(schema.resource).values({
    id: resourceId,
    tenantId,
    kind: 'model',
    modality: 'text',
    providerType: STUB_PROVIDER,
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string' }],
    },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
    active: true,
  });
  await db
    .insert(schema.upstreamChannel)
    .values({ resourceId, providerType: STUB_PROVIDER, weight: 1, status: 'active' });
}

describe('§12 acceptance', () => {
  it('criterion 1: blocking run with the seeded key → 200 output+usage+cost, settle row, debit', async () => {
    const [acctBefore] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.tenantId, seedTenantId));
    const balanceBefore = acctBefore?.creditBalance ?? 0n;

    const res = await bearer(
      request(app.getHttpServer())
        .post(`/v1/run/${SEED_RESOURCE}`)
        .send({ inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } }),
    ).expect(200);

    expect(res.body.status).toBe('succeeded');
    expect(res.body.output).toEqual({ text: 'echo: hi' });
    expect(res.body.usage).toEqual({ tokens: STUB_TOKENS });
    expect(res.body.cost).toEqual({ credits: String(STUB_TOKENS) });

    const jobId = res.body.job_id as string;

    // exactly one settle ledger row, at the final cost
    const settleRows = (
      await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(BigInt(-STUB_TOKENS));

    // account debited by the final cost; hold released
    const [acctAfter] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.tenantId, seedTenantId));
    expect(acctAfter?.creditBalance).toBe(balanceBefore - BigInt(STUB_TOKENS));
    expect(acctAfter?.creditHeld).toBe(0n);
  });

  it('criterion 2: insufficient balance → 402 insufficient_credits, no job created', async () => {
    // A second, low-balance tenant owning its OWN resource (100 µcredits: too
    // small for the 1000-token hold). The run resolves the resource, then the
    // atomic hold fails → insufficient_credits, with no job created.
    const poorTenant = await createTenant(db, { name: 'poor-tenant' });
    const [poorAccount] = await db
      .insert(schema.account)
      .values({ tenantId: poorTenant.id, creditBalance: 100n, creditHeld: 0n })
      .returning();
    if (!poorAccount) throw new Error('poor account insert returned no row');
    const poorResourceId = 'poor-resource';
    await provisionResource(poorTenant.id, poorResourceId);
    const poorKey = await createApiKey(db, {
      tenantId: poorTenant.id,
      resourceAllowlist: [poorResourceId],
    });

    const jobsBefore = await db.select().from(schema.job);

    const res = await bearer(
      request(app.getHttpServer())
        .post(`/v1/run/${poorResourceId}`)
        .send({ inputs: { prompt: 'hi' }, estimated_usage: { tokens: 1000 } }),
      poorKey.plaintext,
    ).expect(402);

    expect(res.body.error.code).toBe('insufficient_credits');

    // no NEW job created
    const jobsAfter = await db.select().from(schema.job);
    expect(jobsAfter).toHaveLength(jobsBefore.length);
  });

  it('criterion 3: same idempotency_key replay → same job_id, no double charge', async () => {
    const idemKey = `acc-idem-${Date.now().toString()}`;
    const body = {
      inputs: { prompt: 'idem' },
      estimated_usage: { tokens: 1000 },
      idempotency_key: idemKey,
    };

    const first = await bearer(
      request(app.getHttpServer()).post(`/v1/run/${SEED_RESOURCE}`).send(body),
    ).expect(200);
    const jobId = first.body.job_id as string;

    const [acctAfterFirst] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.tenantId, seedTenantId));
    const balanceAfterFirst = acctAfterFirst?.creditBalance;

    const second = await bearer(
      request(app.getHttpServer()).post(`/v1/run/${SEED_RESOURCE}`).send(body),
    ).expect(200);

    // same job id
    expect(second.body.job_id).toBe(jobId);

    // exactly one settle row for that job (the replay did not re-charge)
    const settleRows = (
      await db.select().from(schema.ledgerTxn).where(eq(schema.ledgerTxn.jobId, jobId))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);

    // balance unchanged by the replay
    const [acctAfterSecond] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.tenantId, seedTenantId));
    expect(acctAfterSecond?.creditBalance).toBe(balanceAfterFirst);
  });

  it('criterion 4: missing API key → 401 unauthorized; invalid key → 401', async () => {
    const missing = await request(app.getHttpServer())
      .post(`/v1/run/${SEED_RESOURCE}`)
      .send({ inputs: { prompt: 'hi' } })
      .expect(401);
    expect(missing.body.error.code).toBe('unauthorized');

    const invalid = await bearer(
      request(app.getHttpServer())
        .post(`/v1/run/${SEED_RESOURCE}`)
        .send({ inputs: { prompt: 'hi' } }),
      'ak_not-a-real-key',
    ).expect(401);
    expect(invalid.body.error.code).toBe('unauthorized');
  });

  it('criterion 5: rate-limit exceeded → 429 rate_limited + retry_after_ms', async () => {
    // A dedicated tenant+key so this test owns its per-resource window and is not
    // perturbed by the other criteria's traffic. The resource limit is 2/min.
    const rlTenant = await createTenant(db, { name: 'ratelimit-tenant' });
    await db
      .insert(schema.account)
      .values({ tenantId: rlTenant.id, creditBalance: 100_000_000n, creditHeld: 0n });
    // Own a private resource for this tenant so the per-(tenant,resource) bucket
    // is isolated from the other criteria's traffic.
    const rlResourceId = 'rl-resource';
    await provisionResource(rlTenant.id, rlResourceId);
    const rlKey = await createApiKey(db, {
      tenantId: rlTenant.id,
      resourceAllowlist: [rlResourceId],
      // The key's own per-(tenant,resource) cap overrides the generous default.
      rateLimit: TINY_RESOURCE_LIMIT,
    });

    const send = (): request.Test =>
      bearer(
        request(app.getHttpServer())
          .post(`/v1/run/${rlResourceId}`)
          .send({ inputs: { prompt: 'rl' }, estimated_usage: { tokens: 1000 } }),
        rlKey.plaintext,
      );

    // Two requests allowed (limit 2), the third trips the per-resource bucket.
    await send().expect(200);
    await send().expect(200);
    const blocked = await send().expect(429);

    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.retryable).toBe(true);
    expect(blocked.body.error.retry_after_ms).toBeTypeOf('number');
    expect(blocked.body.error.retry_after_ms).toBeGreaterThan(0);
  });

  it('criterion 6: admin dify import registers a BYO workflow visible via GET /v1/resources/:id', async () => {
    const token = await adminToken();
    const difyResourceId = 'acc-xhs';

    // Import the BYO workflow for the SEED tenant so the seeded API key can see
    // it through the tenant-scoped discovery endpoint.
    const imported = await request(app.getHttpServer())
      .post('/admin/dify/import')
      .set('authorization', `Bearer ${token}`)
      .send({
        tenantId: seedTenantId,
        resourceId: difyResourceId,
        yaml: WORKFLOW_DSL,
        endpoint: 'https://dify.example/v1',
        pricingModel: 'fixed',
      })
      .expect(200);
    expect(imported.body.resource_id).toBe(difyResourceId);

    // The seeded API key (no allowlist) can now discover the imported resource's
    // io_schema via GET /v1/resources/:id.
    const got = await bearer(
      request(app.getHttpServer()).get(`/v1/resources/${difyResourceId}`),
    ).expect(200);

    expect(got.body.id).toBe(difyResourceId);
    expect(got.body.io_schema.inputs.map((i: { key: string }) => i.key)).toEqual(['topic']);
    expect(got.body.io_schema.outputs.map((o: { key: string }) => o.key)).toEqual([
      'caption',
      'image_url',
    ]);

    // And it appears in the tenant-scoped list view.
    const list = await bearer(request(app.getHttpServer()).get('/v1/resources')).expect(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(difyResourceId);
  });
});
