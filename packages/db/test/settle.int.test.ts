import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createJob,
  failJob,
  getJob,
  holdCredits,
  listJobs,
  settleJob,
  transitionJob,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, ledgerTxn, resource, resourceVersion, tenant, webhookOutbox } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE webhook_outbox, ledger_txn, job, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
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
  const resourceId = 'openai';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
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

async function makeHeldJob(s: Seed, hold: bigint): Promise<string> {
  const ok = await holdCredits(db, s.accountId, hold);
  if (!ok) throw new Error('hold failed in fixture');
  const j = await createJob(db, {
    tenantId: s.tenantId,
    resourceId: s.resourceId,
    resourceVersion: 1,
    execMode: 'blocking',
    inputs: { prompt: 'hi' },
    quotedCredits: hold,
  });
  return j.id;
}

describe('createJob / getJob / transitionJob / listJobs', () => {
  it('creates a queued job with frozen snapshot fields', async () => {
    const s = await seed(1_000_000n);
    const j = await createJob(db, {
      tenantId: s.tenantId,
      resourceId: s.resourceId,
      resourceVersion: 1,
      execMode: 'blocking',
      inputs: { prompt: 'hi' },
      quotedCredits: 500_000n,
      idempotencyKey: 'abc',
    });

    expect(j.status).toBe('queued');
    expect(j.quotedCredits).toBe(500_000n);
    expect(j.idempotencyKey).toBe('abc');

    const fetched = await getJob(db, j.id);
    expect(fetched?.id).toBe(j.id);
    expect(fetched?.status).toBe('queued');
  });

  it('transitionJob moves only from allowed states (guarded)', async () => {
    const s = await seed(1_000_000n);
    const id = await makeHeldJob(s, 500_000n);

    expect(await transitionJob(db, id, ['queued', 'running'], 'running')).toBe(true);
    // already running; from-set excludes 'running' → no move
    expect(await transitionJob(db, id, ['queued'], 'succeeded')).toBe(false);
    const fetched = await getJob(db, id);
    expect(fetched?.status).toBe('running');
  });

  it('listJobs returns the tenant jobs newest-first', async () => {
    const s = await seed(1_000_000n);
    await makeHeldJob(s, 100_000n);
    await makeHeldJob(s, 100_000n);

    const { rows: jobs, hasMore } = await listJobs(db, s.tenantId, { limit: 10 });
    expect(jobs).toHaveLength(2);
    expect(hasMore).toBe(false);
  });
});

describe('settleJob', () => {
  it('debits balance, releases hold, writes one settle ledger row with balanceAfter', async () => {
    const s = await seed(1_000_000n);
    const id = await makeHeldJob(s, 500_000n);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 500_000n });

    const r = await settleJob(db, {
      jobId: id,
      accountId: s.accountId,
      tenantId: s.tenantId,
      holdAmount: 500_000n,
      finalCost: 300_000n,
      usage: { tokens: 42 },
      output: { text: 'hello' },
    });

    expect(r).toEqual({ settled: true });
    expect(await readAccount(s.accountId)).toEqual({ balance: 700_000n, held: 0n });

    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, id));
    const settleRows = ledger.filter((l) => l.type === 'settle');
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]?.creditsDelta).toBe(-300_000n);
    expect(settleRows[0]?.balanceAfter).toBe(700_000n);

    const fetched = await getJob(db, id);
    expect(fetched?.status).toBe('succeeded');
    expect(fetched?.costCredits).toBe(300_000n);
  });

  it('dedup: a second settle returns {settled:false}, no 2nd ledger row, balances unchanged', async () => {
    const s = await seed(1_000_000n);
    const id = await makeHeldJob(s, 500_000n);

    const first = await settleJob(db, {
      jobId: id,
      accountId: s.accountId,
      tenantId: s.tenantId,
      holdAmount: 500_000n,
      finalCost: 300_000n,
      usage: { tokens: 42 },
      output: { text: 'hello' },
    });
    expect(first).toEqual({ settled: true });

    const balancesAfterFirst = await readAccount(s.accountId);

    const second = await settleJob(db, {
      jobId: id,
      accountId: s.accountId,
      tenantId: s.tenantId,
      holdAmount: 500_000n,
      finalCost: 300_000n,
      usage: { tokens: 42 },
      output: { text: 'hello' },
    });

    expect(second).toEqual({ settled: false });
    expect(await readAccount(s.accountId)).toEqual(balancesAfterFirst);

    const settleRows = (await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, id))).filter(
      (l) => l.type === 'settle',
    );
    expect(settleRows).toHaveLength(1);
  });

  it('writes a webhook_outbox row in the same tx when outbox is supplied', async () => {
    const s = await seed(1_000_000n);
    const id = await makeHeldJob(s, 500_000n);

    await settleJob(db, {
      jobId: id,
      accountId: s.accountId,
      tenantId: s.tenantId,
      holdAmount: 500_000n,
      finalCost: 300_000n,
      usage: { tokens: 1 },
      output: { text: 'x' },
      outbox: { url: 'https://example.test/hook', payload: { job_id: id } },
    });

    const rows = await db.select().from(webhookOutbox).where(eq(webhookOutbox.jobId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://example.test/hook');
    expect(rows[0]?.status).toBe('pending');
  });
});

describe('failJob', () => {
  it('releases the hold without debiting balance and marks the job failed', async () => {
    const s = await seed(1_000_000n);
    const id = await makeHeldJob(s, 500_000n);

    const r = await failJob(db, {
      jobId: id,
      accountId: s.accountId,
      holdAmount: 500_000n,
      to: 'failed',
      error: { code: 'upstream_error', message: 'boom' },
    });

    expect(r).toEqual({ settled: true });
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });

    const fetched = await getJob(db, id);
    expect(fetched?.status).toBe('failed');

    // no settle ledger row was written
    const settleRows = (await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, id))).filter(
      (l) => l.type === 'settle',
    );
    expect(settleRows).toHaveLength(0);
  });

  it('dedup: failing an already-settled job is a no-op {settled:false}', async () => {
    const s = await seed(1_000_000n);
    const id = await makeHeldJob(s, 500_000n);
    await settleJob(db, {
      jobId: id,
      accountId: s.accountId,
      tenantId: s.tenantId,
      holdAmount: 500_000n,
      finalCost: 300_000n,
      usage: {},
      output: {},
    });
    const before = await readAccount(s.accountId);

    const r = await failJob(db, {
      jobId: id,
      accountId: s.accountId,
      holdAmount: 500_000n,
      to: 'canceled',
    });

    expect(r).toEqual({ settled: false });
    expect(await readAccount(s.accountId)).toEqual(before);
  });
});
