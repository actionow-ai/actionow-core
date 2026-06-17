import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterRegistry } from '@actionow/adapters';
import type {
  IoSchema,
  PricebookEntry,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getTableName, type Table } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ExecutionService, type RunRequest } from '../src/execution-service.js';

const { account, resource, resourceVersion, tenant } = schema;

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
  await client`TRUNCATE TABLE usage_log, webhook_outbox, ledger_txn, idempotency_key, job, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
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

/** A `model_token` post-timed pricebook entry: µUSD per 1M tokens ($1.25/1M in, $10/1M out). */
const MODEL_TOKEN_PRICEBOOK: PricebookEntry = {
  resourceId: 'openai',
  resourceVersion: 1,
  version: 1,
  method: 'model_token',
  timing: 'post',
  spec: { method: 'model_token', inputPrice: 1_250_000, outputPrice: 10_000_000 },
};

/** A `unit` post-timed pricebook entry: 1 µcredit per token (non-relay shape). */
const UNIT_PRICEBOOK: PricebookEntry = {
  resourceId: 'openai',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
};

/**
 * A fake blocking LLM adapter returning a fixed text + the supplied usage vector.
 * Both the `model_token` cost and the usage_log mirror read the snake_case
 * `UsageVector` (`input_tokens`/`output_tokens`) every real adapter emits, so a
 * relay run supplies snake_case only.
 */
function fakeLlmAdapter(usage: UsageVector): ProviderAdapter {
  return {
    providerType: 'fake-llm',
    submit(input: SubmitInput): Promise<SubmitResult> {
      const prompt = input.inputs.prompt;
      return Promise.resolve({
        kind: 'sync',
        output: { text: `echo: ${String(prompt)}` },
        usage,
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

function buildService(adapters: AdapterRegistry, dbOverride?: typeof db): ExecutionService {
  return new ExecutionService({
    db: dbOverride ?? db,
    adapters,
    resolveSecret: () => Promise.resolve('sk-secret'),
    http: { request: () => Promise.reject(new Error('http should not be called')) },
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
    pricebookEntry: MODEL_TOKEN_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1', model: 'gpt' }],
    inputs: { prompt: 'hi' },
    execMode: 'blocking',
    tenantId: s.tenantId,
    accountId: s.accountId,
    holdFloor: 1_000_000n,
    ...overrides,
  };
}

describe('ExecutionService.settleSync — usage_log mirror', () => {
  it('writes one usage_log row for a relay run (usageLogModel set)', async () => {
    const s = await seed(10_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter({ input_tokens: 100, output_tokens: 50 }));
    const svc = buildService(adapters);

    const outcome = await svc.run(baseRequest(s, { usageLogModel: 'gpt-4o' }));
    expect(outcome.status).toBe('succeeded');

    const logs =
      await client`SELECT model, input_tokens, output_tokens, cost, status FROM usage_log`;
    expect(logs).toHaveLength(1);
    expect(logs[0]?.model).toBe('gpt-4o');
    expect(Number(logs[0]?.input_tokens)).toBe(100);
    expect(Number(logs[0]?.output_tokens)).toBe(50);
    // roundHalfUp((100*1_250_000 + 50*10_000_000)/1e6) = roundHalfUp(625) = 625 µUSD.
    expect(BigInt(logs[0]?.cost as string)).toBe(625n);
    expect(logs[0]?.status).toBe('succeeded');
  });

  it('writes NO usage_log row for a non-relay run (usageLogModel absent)', async () => {
    const s = await seed(10_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter({ tokens: 300 }));
    const svc = buildService(adapters);

    const outcome = await svc.run(
      baseRequest(s, { pricebookEntry: UNIT_PRICEBOOK }), // no usageLogModel
    );
    expect(outcome.status).toBe('succeeded');

    const logs = await client`SELECT 1 FROM usage_log`;
    expect(logs).toHaveLength(0);
  });

  it('does not fail the settle when the usage_log insert throws (best-effort)', async () => {
    const s = await seed(10_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(fakeLlmAdapter({ input_tokens: 100, output_tokens: 50 }));

    // A db handle whose `insert(usage_log)` throws (other inserts pass through).
    // `createJob`/`settleJob` insert into other tables, so only the usage-log
    // mirror (`this.deps.db.insert(usageLog)`) is sabotaged.
    const failingInsert = vi.fn(() => {
      throw new Error('usage_log insert boom');
    });
    const realInsert = db.insert.bind(db);
    const sabotaged = new Proxy(db, {
      get(target, prop, receiver): unknown {
        if (prop === 'insert') {
          return (table: Table) => {
            if (getTableName(table) === 'usage_log') return failingInsert();
            return realInsert(table);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const svc = buildService(adapters, sabotaged);

    // The settle must still succeed (the credits were settled, the log is best-effort).
    const outcome = await svc.run(baseRequest(s, { usageLogModel: 'gpt-4o' }));
    expect(outcome.status).toBe('succeeded');
    expect(failingInsert).toHaveBeenCalled();

    // The settle wrote the job + ledger; the usage_log row is absent.
    const logs = await client`SELECT 1 FROM usage_log`;
    expect(logs).toHaveLength(0);
    const jobs = await client`SELECT status FROM job`;
    expect(jobs[0]?.status).toBe('succeeded');
  });
});
