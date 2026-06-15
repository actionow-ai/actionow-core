import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterError, AdapterRegistry } from '@actionow/adapters';
import type {
  IoSchema,
  PricebookEntry,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { getJob, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EngineError } from '../src/errors.js';
import { ExecutionService, type RunRequest } from '../src/execution-service.js';

const { account, ledgerTxn, resource, resourceVersion, tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE webhook_outbox, ledger_txn, idempotency_key, job, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

interface Seed {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

const IO_SCHEMA: IoSchema = {
  inputs: [{ key: 'prompt', type: 'string', required: true }],
  outputs: [{ key: 'text', type: 'string' }],
};

async function seed(balance: bigint): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const resourceId = 'openai';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'fake-llm',
    execModes: ['blocking'],
  });
  await db.insert(resourceVersion).values({ resourceId, version: 1, ioSchema: IO_SCHEMA });
  return { tenantId: t.id, accountId: a.id, resourceId };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

/** A pricebook entry with a post (unit) method: 1 µcredit per token. */
const POST_PRICEBOOK: PricebookEntry = {
  resourceId: 'openai',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
};

/** A fake blocking LLM adapter returning a fixed text + token usage. */
function fakeLlmAdapter(usageTokens: number): ProviderAdapter {
  return {
    providerType: 'fake-llm',
    submit(input: SubmitInput): Promise<SubmitResult> {
      const prompt = input.inputs.prompt;
      return Promise.resolve({
        kind: 'sync',
        output: { text: `echo: ${String(prompt)}` },
        usage: { tokens: usageTokens },
      });
    },
    extractUsage(): UsageVector {
      return {};
    },
    mapError(): UnifiedError {
      return { code: 'upstream_error', message: 'fake', retryable: false };
    },
  };
}

function buildService(adapters: AdapterRegistry): ExecutionService {
  return new ExecutionService({
    db,
    adapters,
    resolveSecret: () => Promise.resolve('sk-secret'),
    http: { request: () => Promise.reject(new Error('http should not be called by fake adapter')) },
    now: () => new Date('2026-06-16T00:00:00.000Z'),
    enqueue: vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve()),
  });
}

function baseRequest(s: Seed, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    resource: {
      id: s.resourceId,
      version: 1,
      modality: 'text',
      ioSchema: IO_SCHEMA,
      execModes: ['blocking'],
      providerType: 'fake-llm',
    },
    pricebookEntry: POST_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1', model: 'gpt', endpoint: undefined }],
    inputs: { prompt: 'hi' },
    execMode: 'blocking',
    tenantId: s.tenantId,
    accountId: s.accountId,
    estimatedUsage: { tokens: 1000 },
    ...overrides,
  };
}

describe('ExecutionService.run — blocking', () => {
  it('debits the ledger by final cost and returns output on success', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    const outcome = await svc.run(baseRequest(s));

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.output).toEqual({ text: 'echo: hi' });
    expect(outcome.usage).toEqual({ tokens: 300 });
    expect(outcome.cost.credits).toBe(300n);

    // balance debited by final cost (300), hold released to 0
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_700n, held: 0n });

    // one settle ledger row with the final cost
    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, outcome.jobId));
    const settleRows = ledger.filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(-300n);
    expect(settleRows[0]?.balanceAfter).toBe(999_700n);

    const job = await getJob(db, outcome.jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.costCredits).toBe(300n);
  });

  it('returns insufficient_credits and creates NO job when balance is too low', async () => {
    const s = await seed(100n); // far below the 1000-token upper-bound hold
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    await expect(svc.run(baseRequest(s))).rejects.toMatchObject({
      unified: { code: 'insufficient_credits' },
    });

    // no job created, hold not placed
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(0);
    expect(await readAccount(s.accountId)).toEqual({ balance: 100n, held: 0n });
  });

  it('replays the same job for a repeated idempotency key', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    const first = await svc.run(baseRequest(s, { idempotencyKey: 'key-1' }));
    const second = await svc.run(baseRequest(s, { idempotencyKey: 'key-1' }));

    expect(second.jobId).toBe(first.jobId);

    // only one job, only one settle row → no double execution / double charge
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(1);
    const settleRows = (await db.select().from(ledgerTxn)).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_700n, held: 0n });
  });

  it('rejects invalid inputs with invalid_input and creates no job', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const svc = buildService(adapters);

    await expect(svc.run(baseRequest(s, { inputs: {} }))).rejects.toMatchObject({
      unified: { code: 'invalid_input' },
    });

    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(0);
  });

  it('fails over to the second channel when the first retryably throws', async () => {
    const s = await seed(1_000_000n);

    let attempts = 0;
    const failoverAdapter: ProviderAdapter = {
      providerType: 'fake-llm',
      submit(input: SubmitInput): Promise<SubmitResult> {
        attempts += 1;
        if (input.ctx.endpoint === 'https://a.example') {
          throw new AdapterError({
            code: 'upstream_error',
            message: 'channel A 503',
            retryable: true,
          });
        }
        return Promise.resolve({
          kind: 'sync',
          output: { text: 'from B' },
          usage: { tokens: 50 },
        });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
    };
    const adapters = new AdapterRegistry();
    adapters.register(failoverAdapter);
    const svc = buildService(adapters);

    const outcome = await svc.run(
      baseRequest(s, {
        channels: [
          {
            id: 'A',
            weight: 1,
            credentialRef: 'ref-a',
            model: 'gpt',
            endpoint: 'https://a.example',
          },
          {
            id: 'B',
            weight: 0,
            credentialRef: 'ref-b',
            model: 'gpt',
            endpoint: 'https://b.example',
          },
        ],
        // force the weighted pick to land on A (weight 1 vs 0) so failover -> B
      }),
    );

    expect(attempts).toBe(2);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.output).toEqual({ text: 'from B' });
    expect(outcome.cost.credits).toBe(50n);
  });

  it('fails the job and raises upstream_error when every channel throws', async () => {
    const s = await seed(1_000_000n);
    const alwaysFails: ProviderAdapter = {
      providerType: 'fake-llm',
      submit(): Promise<SubmitResult> {
        throw new AdapterError({ code: 'upstream_error', message: 'down', retryable: true });
      },
      extractUsage: () => ({}),
      mapError: () => ({ code: 'upstream_error', message: 'down', retryable: true }),
    };
    const adapters = new AdapterRegistry();
    adapters.register(alwaysFails);
    const svc = buildService(adapters);

    await expect(svc.run(baseRequest(s))).rejects.toBeInstanceOf(EngineError);

    // hold released by failJob → held back to 0, balance untouched
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('failed');
  });
});

describe('ExecutionService.run — async', () => {
  it('holds, creates a queued job, enqueues, and returns {status:queued}', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter(300));
    const enqueue = vi.fn<(jobId: string) => Promise<void>>(() => Promise.resolve());
    const svc = new ExecutionService({
      db,
      adapters,
      resolveSecret: () => Promise.resolve('sk-secret'),
      http: { request: () => Promise.reject(new Error('no http')) },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
      enqueue,
    });

    const outcome = await svc.run(
      baseRequest(s, {
        execMode: 'async-poll',
        resource: {
          id: s.resourceId,
          version: 1,
          modality: 'text',
          ioSchema: IO_SCHEMA,
          execModes: ['async-poll'],
          providerType: 'fake-llm',
        },
      }),
    );

    expect(outcome.status).toBe('queued');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(outcome.jobId);

    // hold placed, job queued, nothing settled yet
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 1_000n });
    const job = await getJob(db, outcome.jobId);
    expect(job?.status).toBe('queued');
    const settleRows = (await db.select().from(ledgerTxn)).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(0);
  });
});
