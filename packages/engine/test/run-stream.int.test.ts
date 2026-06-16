import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterRegistry } from '@actionow/adapters';
import type {
  IoSchema,
  PricebookEntry,
  StreamEvent,
  SubmitResult,
  UsageVector,
} from '@actionow/contracts';
import { getJob, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
  const resourceId = 'mock-stream-resource';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'mock-stream',
    execModes: ['stream'],
  });
  await db.insert(resourceVersion).values({ resourceId, version: 1, ioSchema: IO_SCHEMA });
  return { tenantId: t.id, accountId: a.id, resourceId };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

/** A post (unit) pricebook: 1 µcredit per output_token → mock usage (5) → 5µ. */
const POST_PRICEBOOK: PricebookEntry = {
  resourceId: 'mock-stream-resource',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
};

/** The deterministic mock-stream adapter: deltas 'hel','lo' then usage 5/10. */
function mockStreamAdapter(): ProviderAdapter {
  const usage: UsageVector = { input_tokens: 10, output_tokens: 5 };
  return {
    providerType: 'mock-stream',
    submit(): Promise<SubmitResult> {
      return Promise.resolve({ kind: 'sync', output: { text: 'hello' }, usage: { ...usage } });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(): AsyncIterable<StreamEvent> {
      yield { kind: 'delta', text: 'hel' };
      yield { kind: 'delta', text: 'lo' };
      yield { kind: 'usage', usage: { ...usage } };
      yield { kind: 'done', usage: { ...usage } };
    },
    extractUsage: () => ({ ...usage }),
    mapError: () => ({ code: 'upstream_error', message: 'mock', retryable: false }),
  };
}

/** A stream adapter that throws mid-stream after the first delta. */
function failingStreamAdapter(): ProviderAdapter {
  return {
    providerType: 'mock-stream',
    submit(): Promise<SubmitResult> {
      return Promise.resolve({ kind: 'sync', output: {}, usage: {} });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(): AsyncIterable<StreamEvent> {
      yield { kind: 'delta', text: 'hel' };
      throw new Error('upstream exploded');
    },
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'boom', retryable: false }),
  };
}

function buildService(adapters: AdapterRegistry): ExecutionService {
  return new ExecutionService({
    db,
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
      execModes: ['stream'],
      providerType: 'mock-stream',
    },
    pricebookEntry: POST_PRICEBOOK,
    modifiers: [],
    channels: [{ id: 'c1', weight: 1, credentialRef: 'ref-1' }],
    inputs: { prompt: 'hi' },
    execMode: 'stream',
    tenantId: s.tenantId,
    accountId: s.accountId,
    estimatedUsage: { output_tokens: 1000 },
    ...overrides,
  };
}

async function settleRowsFor(jobId: string): Promise<(typeof schema.ledgerTxn.$inferSelect)[]> {
  const rows = await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, jobId));
  return rows.filter((l) => l.type === 'settle');
}

describe('ExecutionService.runStream', () => {
  it('streams deltas, then settles exactly once with the final usage cost', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(mockStreamAdapter());
    const svc = buildService(adapters);

    const { jobId, events } = await svc.runStream(baseRequest(s));

    // Hold placed before any event (1000-token upper bound = 1000µ).
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 1_000n });

    const collected: StreamEvent[] = [];
    for await (const ev of events) collected.push(ev);

    // delta sequence then a usage then a final done carrying cost+usage.
    expect(collected.filter((e) => e.kind === 'delta').map((e) => e.text)).toEqual(['hel', 'lo']);
    const usageEv = collected.find((e) => e.kind === 'usage');
    expect(usageEv?.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const done = collected.find((e) => e.kind === 'done');
    expect(done).toBeDefined();

    // exactly one settle ledger row, debited by the 5-token cost (5µ).
    const settleRows = await settleRowsFor(jobId);
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(-5n);

    // account debited 5, hold released to 0.
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_995n, held: 0n });

    const job = await getJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.costCredits).toBe(5n);
  });

  it('settles exactly once charging the held upper bound when the consumer disconnects early (return())', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(mockStreamAdapter());
    const svc = buildService(adapters);

    const { jobId, events } = await svc.runStream(baseRequest(s));

    // Hold = 1000-token upper bound × 1µ/token = 1000µ.
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 1_000n });

    // Consume only the first delta, then break out → triggers iterator.return()
    // BEFORE the upstream usage frame arrives (no usage captured).
    const iter = events[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toMatchObject({ kind: 'delta', text: 'hel' });
    // Early-return the iterator (simulates a client disconnect / SSE unsubscribe).
    await iter.return?.(undefined);

    // The generator's finally still settled exactly once.
    const settleRows = await settleRowsFor(jobId);
    expect(settleRows).toHaveLength(1);
    // No usage was captured before disconnect → charge the held upper bound
    // (1000µ), NOT 0 (which would leak the provider tokens already consumed).
    expect(settleRows[0]?.creditsDelta).toBe(-1_000n);

    // Account debited the full held bound, hold released to 0.
    const acct = await readAccount(s.accountId);
    expect(acct).toEqual({ balance: 999_000n, held: 0n });

    const job = await getJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.costCredits).toBe(1_000n);
  });

  it('settles (fail/release) exactly once when the adapter throws mid-stream', async () => {
    const s = await seed(1_000_000n);
    const adapters = new AdapterRegistry();
    adapters.register(failingStreamAdapter());
    const svc = buildService(adapters);

    const { jobId, events } = await svc.runStream(baseRequest(s));

    const collected: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of events) collected.push(ev);
      })(),
    ).rejects.toThrow();

    // Got the first delta before the throw.
    expect(collected.filter((e) => e.kind === 'delta').map((e) => e.text)).toEqual(['hel']);

    // The job is failed and the hold released; no settle ledger row.
    const settleRows = await settleRowsFor(jobId);
    expect(settleRows).toHaveLength(0);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });

    const job = await getJob(db, jobId);
    expect(job?.status).toBe('failed');
  });

  it('rejects with insufficient_credits before any event and creates no job', async () => {
    const s = await seed(100n); // far below the 1000-token upper-bound hold
    const adapters = new AdapterRegistry();
    adapters.register(mockStreamAdapter());
    const svc = buildService(adapters);

    await expect(svc.runStream(baseRequest(s))).rejects.toMatchObject({
      unified: { code: 'insufficient_credits' },
    });

    const jobs = await db.select().from(schema.job);
    expect(jobs).toHaveLength(0);
    expect(await readAccount(s.accountId)).toEqual({ balance: 100n, held: 0n });
  });
});
