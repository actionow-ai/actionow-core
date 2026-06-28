import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { refundJob } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, job, ledgerTxn, resource, subAccount, subject, tenant } = schema;

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
  await client`TRUNCATE TABLE ledger_txn, job, sub_account, subject, account, resource, tenant RESTART IDENTITY CASCADE`;
});

interface Seed {
  tenantId: string;
  accountId: string;
  jobId: string;
  subjectId: string | null;
}

let resCounter = 0;

/** Seed tenant + account (+ optional sub-wallet) + a succeeded job carrying `cost`. */
async function seedSettledJob(opts: {
  cost: bigint | null;
  balance?: bigint;
  status?: 'succeeded' | 'running';
  withSubWallet?: boolean;
  subWalletBalance?: bigint;
}): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('no tenant');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: opts.balance ?? 1_000_000n, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('no account');

  let subjectId: string | null = null;
  if (opts.withSubWallet === true) {
    const [s] = await db.insert(subject).values({ tenantId: t.id, externalId: 'u1' }).returning();
    if (!s) throw new Error('no subject');
    subjectId = s.id;
    await db.insert(subAccount).values({
      tenantId: t.id,
      subjectId: s.id,
      creditBalance: opts.subWalletBalance ?? 0n,
      creditHeld: 0n,
    });
  }

  const resourceId = `res-${String((resCounter += 1))}`;
  await db.insert(resource).values({
    id: resourceId,
    kind: 'model',
    modality: 'text',
    providerType: 'mock-chat',
    execModes: ['blocking'],
  });
  const [j] = await db
    .insert(job)
    .values({
      tenantId: t.id,
      resourceId,
      resourceVersion: 1,
      status: opts.status ?? 'succeeded',
      execMode: 'blocking',
      inputs: {},
      accountId: a.id,
      subjectId,
      ...(opts.cost !== null ? { costCredits: opts.cost } : {}),
    })
    .returning();
  if (!j) throw new Error('no job');
  return { tenantId: t.id, accountId: a.id, jobId: j.id, subjectId };
}

async function balance(accountId: string): Promise<bigint> {
  const [row] = await db.select().from(account).where(eq(account.id, accountId));
  if (!row) throw new Error('no account');
  return row.creditBalance;
}

async function refundRows(jobId: string): Promise<bigint[]> {
  const rows = await db.select().from(ledgerTxn).where(eq(ledgerTxn.jobId, jobId));
  return rows.filter((r) => r.type === 'refund').map((r) => r.creditsDelta);
}

describe('refundJob', () => {
  it('full refund credits the pool back + writes one +refund ledger row; idempotent', async () => {
    const s = await seedSettledJob({ cost: 50n, balance: 100n });

    const r1 = await refundJob(db, { jobId: s.jobId });
    expect(r1).toMatchObject({ status: 'ok', refunded: 50n, balanceAfter: 150n });
    expect(await balance(s.accountId)).toBe(150n);
    expect(await refundRows(s.jobId)).toEqual([50n]);

    // a repeated full refund is a no-op (nothing refundable) — never over-refunds
    const r2 = await refundJob(db, { jobId: s.jobId });
    expect(r2.status).toBe('nothing_refundable');
    expect(r2.refunded).toBe(0n);
    expect(await balance(s.accountId)).toBe(150n);
    expect(await refundRows(s.jobId)).toEqual([50n]);
  });

  it('partial refunds accumulate and cap at the settled cost', async () => {
    const s = await seedSettledJob({ cost: 50n, balance: 100n });

    expect((await refundJob(db, { jobId: s.jobId, amount: 20n })).refunded).toBe(20n);
    // a 40 request when only 30 remains → capped to 30
    expect((await refundJob(db, { jobId: s.jobId, amount: 40n })).refunded).toBe(30n);
    expect((await refundJob(db, { jobId: s.jobId })).status).toBe('nothing_refundable');
    expect(await balance(s.accountId)).toBe(150n); // 100 + 50 total, never more
    expect(await refundRows(s.jobId)).toEqual([20n, 30n]);
  });

  it('caps a too-large amount to the full refundable', async () => {
    const s = await seedSettledJob({ cost: 50n, balance: 0n });
    const r = await refundJob(db, { jobId: s.jobId, amount: 999n });
    expect(r).toMatchObject({ status: 'ok', refunded: 50n, balanceAfter: 50n });
  });

  it('returns not_settled for a non-succeeded job or one with no cost', async () => {
    const running = await seedSettledJob({ cost: 50n, status: 'running' });
    expect((await refundJob(db, { jobId: running.jobId })).status).toBe('not_settled');
    const noCost = await seedSettledJob({ cost: null });
    expect((await refundJob(db, { jobId: noCost.jobId })).status).toBe('not_settled');
  });

  it('returns job_not_found for an unknown job', async () => {
    const r = await refundJob(db, { jobId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe('job_not_found');
  });

  it('refunds the SUBJECT sub-wallet (HARD mode), not the tenant pool', async () => {
    const s = await seedSettledJob({
      cost: 50n,
      balance: 100n,
      withSubWallet: true,
      subWalletBalance: 10n,
    });
    const r = await refundJob(db, { jobId: s.jobId });
    expect(r).toMatchObject({ status: 'ok', refunded: 50n, balanceAfter: 60n }); // sub-wallet 10 → 60
    expect(await balance(s.accountId)).toBe(100n); // tenant pool untouched
    const [sub] = await db
      .select()
      .from(subAccount)
      .where(eq(subAccount.subjectId, s.subjectId ?? ''));
    expect(sub?.creditBalance).toBe(60n);
  });
});
