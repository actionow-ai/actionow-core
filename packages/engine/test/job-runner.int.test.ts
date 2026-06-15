import { AdapterRegistry, createAsyncMediaMock } from '@actionow/adapters';
import type { PollResult, PricebookEntry } from '@actionow/contracts';
import { createJob, getJob, holdCredits, type Job, schema, setUpstreamHandle } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type JobExecutionContext, JobRunner } from '../src/job-runner.js';

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
  return { tenantId: t.id, accountId: a.id, resourceId };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

/** post (unit) pricing: 100 µcredits per produced image. */
const IMAGE_PRICEBOOK: PricebookEntry = {
  resourceId: 'mock-image',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { images: { rate: 100 } } },
};

async function makeQueuedJob(s: Seed, hold: bigint): Promise<Job> {
  const ok = await holdCredits(db, s.accountId, hold);
  if (!ok) throw new Error('hold failed in fixture');
  return createJob(db, {
    tenantId: s.tenantId,
    resourceId: s.resourceId,
    resourceVersion: 1,
    execMode: 'async-poll',
    inputs: { prompt: 'a cat' },
    quotedCredits: hold,
  });
}

function contextFor(s: Seed): JobExecutionContext {
  return {
    accountId: s.accountId,
    providerType: 'async-media-mock',
    modality: 'image',
    pricebookEntry: IMAGE_PRICEBOOK,
    modifiers: [],
    channels: [
      { id: 'c1', weight: 1, credentialRef: undefined, model: undefined, endpoint: undefined },
    ],
  };
}

function buildRunner(s: Seed, adapters: AdapterRegistry): JobRunner {
  return new JobRunner({
    db,
    adapters,
    loadContext: () => Promise.resolve(contextFor(s)),
    resolveSecret: () => Promise.resolve(undefined),
    http: { request: () => Promise.reject(new Error('no http')) },
    maxPolls: 5,
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
  });
}

describe('JobRunner.process — async poll', () => {
  it('drives queued→running→succeeded, settles the ledger, returns image_url', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters);

    await runner.process(job.id);

    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');
    expect(settled?.output).toMatchObject({ image_url: expect.any(String) });
    expect(settled?.usage).toEqual({ images: 1 });
    expect(settled?.costCredits).toBe(100n);

    // balance debited by 100, hold released
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_900n, held: 0n });

    const settleRows = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, job.id))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.balanceAfter).toBe(999_900n);
  });

  it('no-ops when the job is already terminal (idempotent process)', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters);

    await runner.process(job.id);
    const after1 = await readAccount(s.accountId);
    await runner.process(job.id); // second run: job is succeeded, transition guard no-ops

    expect(await readAccount(s.accountId)).toEqual(after1);
    const settleRows = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, job.id))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
  });
});

describe('JobRunner — poll + callback double-settle dedup', () => {
  it('settling twice (poll then callback) writes exactly one ledger row', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters);

    // First: drive the poll path to settle.
    await runner.process(job.id);
    const balancesAfterPoll = await readAccount(s.accountId);

    // Then: a late upstream callback for the same job. parseCallback needs the
    // upstream handle that process() persisted; build the callback payload from it.
    const persisted = await getJob(db, job.id);
    const upstreamJobId = persisted?.upstreamJobHandle;
    if (upstreamJobId === null || upstreamJobId === undefined) {
      throw new Error('expected upstream handle to be persisted');
    }
    const second = await runner.handleCallback({ upstreamJobId, status: 'succeeded' });

    // Dedup: the second settle is a no-op; balances unchanged, one ledger row.
    expect(second).toEqual({ settled: false });
    expect(await readAccount(s.accountId)).toEqual(balancesAfterPoll);
    const settleRows = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, job.id))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
  });

  it('handleCallback settles a queued/running job correlated by its upstream handle', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters);

    // Simulate an async-callback resource: the job is in-flight with a known
    // upstream handle, awaiting the upstream's POST to /v1/callbacks.
    const upstreamJobId = 'upstream-abc';
    await setUpstreamHandle(db, job.id, upstreamJobId);

    const result = await runner.handleCallback({
      upstreamJobId,
      status: 'succeeded',
    } satisfies PollResult & { upstreamJobId: string });

    expect(result).toEqual({ settled: true });
    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');

    // Exactly one settle ledger row; replaying the same callback is a no-op.
    const again = await runner.handleCallback({ upstreamJobId, status: 'succeeded' });
    expect(again).toEqual({ settled: false });
    const settleRows = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, job.id))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
  });
});
