import { AdapterRegistry, createAsyncMediaMock } from '@actionow/adapters';
import type { Modifier, PollResult, PricebookEntry } from '@actionow/contracts';
import {
  createJob,
  getJob,
  holdCredits,
  insertUsageLog,
  type Job,
  schema,
  setUpstreamHandle,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BreakerStore, RoutableChannelRef } from '../src/breaker.js';
import { type JobExecutionContext, JobRunner } from '../src/job-runner.js';

/**
 * A recording {@link BreakerStore}: `filterAvailable` drops `excludeIds`, and
 * `onSuccess`/`onFailure` are captured so a test can assert the async submit
 * path is breaker-filtered + outcome-fed. Fail-open by construction.
 */
function recordingBreaker(excludeIds: string[] = []): BreakerStore & {
  filtered: number;
  successes: { channelId: string; model: string }[];
  failures: { channelId: string; model: string }[];
} {
  const successes: { channelId: string; model: string }[] = [];
  const failures: { channelId: string; model: string }[] = [];
  const rec = {
    filtered: 0,
    successes,
    failures,
    filterAvailable: <C extends RoutableChannelRef>(channels: readonly C[]): Promise<C[]> => {
      rec.filtered += 1;
      return Promise.resolve(channels.filter((c) => !excludeIds.includes(c.id)));
    },
    onSuccess: (channelId: string, model: string): Promise<void> => {
      successes.push({ channelId, model });
      return Promise.resolve();
    },
    onFailure: (channelId: string, model: string): Promise<void> => {
      failures.push({ channelId, model });
      return Promise.resolve();
    },
    windowStats: (): Promise<null> => Promise.resolve(null),
  };
  return rec;
}

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
  await client`TRUNCATE TABLE usage_log, webhook_outbox, ledger_txn, idempotency_key, job, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
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

function contextFor(s: Seed, modifiers: Modifier[] = []): JobExecutionContext {
  return {
    accountId: s.accountId,
    providerType: 'async-media-mock',
    modality: 'image',
    pricebookEntry: IMAGE_PRICEBOOK,
    modifiers,
    channels: [
      { id: 'c1', weight: 1, credentialRef: undefined, model: undefined, endpoint: undefined },
    ],
  };
}

function buildRunner(s: Seed, adapters: AdapterRegistry, modifiers: Modifier[] = []): JobRunner {
  return new JobRunner({
    db,
    adapters,
    loadContext: () => Promise.resolve(contextFor(s, modifiers)),
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

  it('breaker-filters the submit candidates and feeds onSuccess on a returned handle', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const breaker = recordingBreaker();
    const ctx: JobExecutionContext = {
      ...contextFor(s),
      channels: [{ id: 'c1', weight: 1, model: 'mock-image' }],
    };
    const runner = new JobRunner({
      db,
      adapters,
      loadContext: () => Promise.resolve(ctx),
      resolveSecret: () => Promise.resolve(undefined),
      http: { request: () => Promise.reject(new Error('no http')) },
      maxPolls: 5,
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
      breaker,
    });

    await runner.process(job.id);

    expect((await getJob(db, job.id))?.status).toBe('succeeded');
    // The submit path consulted the breaker filter and recorded the accepted
    // submit as a success, keyed on the channel's resolved model.
    expect(breaker.filtered).toBe(1);
    expect(breaker.successes).toEqual([{ channelId: 'c1', model: 'mock-image' }]);
    expect(breaker.failures).toEqual([]);
  });

  it('persists the MediaResult as output and writes a usage_log row with provider_cost', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    // Context whose channel carries a per-unit cost (1500 µUSD/image).
    const ctx: JobExecutionContext = {
      ...contextFor(s),
      channels: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          weight: 1,
          model: 'mock-image',
          config: { costPerUnit: { images: 1500 } },
        },
      ],
    };
    const runner = new JobRunner({
      db,
      adapters,
      loadContext: () => Promise.resolve(ctx),
      resolveSecret: () => Promise.resolve(undefined),
      http: { request: () => Promise.reject(new Error('no http')) },
      maxPolls: 5,
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
      // Fake persistence: rewrite each asset to a durable URL (no real R2).
      persistMediaResult: (input) =>
        Promise.resolve({
          result: {
            ...input.result,
            assets: input.result.assets.map((a, i) => ({
              ...a,
              url: `https://cdn.x/${input.jobId}-${String(i)}.png`,
            })),
          },
          objects: [],
        }),
      insertUsageLog: async (row) => {
        await insertUsageLog(db, row);
      },
    });

    await runner.process(job.id);

    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');
    // Output is now the canonical MediaResult (assets[]) with the durable URL.
    const out = settled?.output as { kind: string; assets: { url: string }[] };
    expect(out.kind).toBe('media');
    expect(out.assets[0]?.url).toBe(`https://cdn.x/${job.id}-0.png`);

    const logs = await db
      .select()
      .from(schema.usageLog)
      .where(eq(schema.usageLog.tenantId, s.tenantId));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.cost).toBe(100n); // customer charge (1 image × 100 µcredits)
    expect(logs[0]?.providerCost).toBe(1500n); // 1 image × 1500 µUSD costPerUnit
    expect(logs[0]?.status).toBe('succeeded');
  });

  it('honors a per-channel poll budget from config (video can poll past the deps default)', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    // Stays 'running' for 5 polls — MORE than the runner's deps maxPolls (3), so
    // without a per-channel override it would time out. The channel config raises
    // the budget to 10, so a slow (video-like) job succeeds instead.
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 5 }));
    const runner = new JobRunner({
      db,
      adapters,
      loadContext: () =>
        Promise.resolve({
          accountId: s.accountId,
          providerType: 'async-media-mock',
          modality: 'image',
          pricebookEntry: IMAGE_PRICEBOOK,
          modifiers: [],
          channels: [{ id: 'c1', weight: 1, config: { maxPolls: 10, pollIntervalMs: 0 } }],
        }),
      resolveSecret: () => Promise.resolve(undefined),
      http: { request: () => Promise.reject(new Error('no http')) },
      maxPolls: 3,
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });

    await runner.process(job.id);

    expect((await getJob(db, job.id))?.status).toBe('succeeded');
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

describe('JobRunner.failExhausted — terminal-fail on exhausted queue retries', () => {
  it('releases the hold and marks a stranded job failed', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters);

    await runner.failExhausted(job.id, 'exhausted retries');

    expect((await getJob(db, job.id))?.status).toBe('failed');
    // Hold released, balance untouched (no charge on failure) — not held until the reaper.
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
  });

  it('no-ops when the job is already terminal (idempotent with the reaper/late retry)', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters);

    await runner.process(job.id); // → succeeded (debits 100)
    const after = await readAccount(s.accountId);
    await runner.failExhausted(job.id, 'late failure'); // already terminal → no-op

    expect((await getJob(db, job.id))?.status).toBe('succeeded');
    expect(await readAccount(s.accountId)).toEqual(after);
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

describe('JobRunner.settle — applied-modifier serialization (async path)', () => {
  /** A 10%-off tenant modifier; fires against the 100 µcredit base → 90. */
  const PERCENT_OFF_10: Modifier = {
    id: 'mod-async-10off',
    scope: 'tenant:acme',
    op: 'percent_off',
    value: 10,
    stackable: false,
    priority: 0,
    version: 1,
  };

  it('settles with a firing modifier, persisting before/after as decimal strings', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 1 }));
    const runner = buildRunner(s, adapters, [PERCENT_OFF_10]);

    // Must NOT throw: the applied-modifier audit carries bigint before/after,
    // which jsonb cannot serialize unless serializeAppliedModifiers ran first.
    await expect(runner.process(job.id)).resolves.toBeUndefined();

    // base 100 µcredits (1 image × rate 100) − 10% = 90.
    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');
    expect(settled?.costCredits).toBe(90n);
    expect(await readAccount(s.accountId)).toEqual({ balance: 999_910n, held: 0n });

    const settleRows = (
      await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, job.id))
    ).filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);

    // The persisted audit must carry before/after as decimal STRINGS — jsonb
    // round-trips them as strings only because serializeAppliedModifiers
    // converted the bigint µcredits. A regression that drops that call throws
    // on settle, so this ledger row would never be written.
    const applied = settleRows[0]?.modifiersApplied as { before: string; after: string }[];
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ before: '100', after: '90' });
    expect(typeof applied[0]?.before).toBe('string');
    expect(typeof applied[0]?.after).toBe('string');
  });
});

describe('JobRunner.settle — optional media persistence (async path)', () => {
  it('settles with the unchanged output when persistMediaResult is not injected (no-op)', async () => {
    const s = await seed(1_000_000n);
    const job = await makeQueuedJob(s, 1_000n);
    const adapters = new AdapterRegistry();
    adapters.register(createAsyncMediaMock({ readyAfterPolls: 0 }));
    // buildRunner omits persistMedia → behavior is unchanged.
    const runner = buildRunner(s, adapters);

    await runner.process(job.id);

    const settled = await getJob(db, job.id);
    expect(settled?.status).toBe('succeeded');
    const handle = settled?.upstreamJobHandle;
    if (handle === null || handle === undefined) throw new Error('expected upstream handle');
    // The mock emits https://mock.local/{upstreamHandle}; settle must store it verbatim.
    const output = settled?.output as Record<string, unknown> | undefined;
    expect(output?.image_url).toBe(`https://mock.local/${handle}`);
  });
});
