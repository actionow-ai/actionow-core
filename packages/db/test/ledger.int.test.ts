import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { appendLedger, holdCredits, releaseHold, topUp } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, ledgerTxn, tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 20 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  // Truncate between tests; ledger_txn and account FK tenant, cascade order.
  await client`TRUNCATE TABLE ledger_txn, account, tenant RESTART IDENTITY CASCADE`;
});

async function seedAccount(balance: bigint): Promise<{ tenantId: string; accountId: string }> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  return { tenantId: t.id, accountId: a.id };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

describe('holdCredits', () => {
  it('succeeds and increments credit_held when balance - held >= amount', async () => {
    const { accountId } = await seedAccount(1_000_000n);

    const ok = await holdCredits(db, accountId, 400_000n);

    expect(ok).toBe(true);
    expect(await readAccount(accountId)).toEqual({ balance: 1_000_000n, held: 400_000n });
  });

  it('returns false and does not change credit_held when insufficient', async () => {
    const { accountId } = await seedAccount(1_000_000n);
    await holdCredits(db, accountId, 800_000n); // held = 800_000

    const ok = await holdCredits(db, accountId, 300_000n); // available = 200_000 < 300_000

    expect(ok).toBe(false);
    expect(await readAccount(accountId)).toEqual({ balance: 1_000_000n, held: 800_000n });
  });

  it('the DB CHECK would block any oversell (held may never exceed balance)', async () => {
    const { accountId } = await seedAccount(100n);

    const error = await db
      .update(account)
      .set({ creditHeld: 200n })
      .where(eq(account.id, accountId))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(Error);
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    const pg = cause as { code?: unknown; constraint_name?: unknown };
    expect(pg.code).toBe('23514');
    expect(pg.constraint_name).toBe('account_balance_ge_held');
  });

  it('20-way concurrency: exactly K succeed and held never exceeds balance', async () => {
    // balance = 1_000_000, each hold = 250_000 → exactly K=4 of N=20 can fit.
    const { accountId } = await seedAccount(1_000_000n);
    const amount = 250_000n;
    const n = 20;
    const k = 4;

    const results = await Promise.all(
      Array.from({ length: n }, () => holdCredits(db, accountId, amount)),
    );

    const succeeded = results.filter((r) => r).length;
    expect(succeeded).toBe(k);

    const { balance, held } = await readAccount(accountId);
    expect(held).toBe(BigInt(k) * amount);
    expect(held).toBeLessThanOrEqual(balance); // no oversell, ever
  });

  it('a mismatched tenantId holds ZERO and returns false (P2-8 tenant scope)', async () => {
    const { accountId } = await seedAccount(1_000_000n);
    const wrongTenant = '00000000-0000-0000-0000-000000000000';

    const ok = await holdCredits(db, accountId, 100_000n, wrongTenant);

    expect(ok).toBe(false);
    expect(await readAccount(accountId)).toEqual({ balance: 1_000_000n, held: 0n });
  });

  it('the correct tenantId still holds normally (P2-8)', async () => {
    const { tenantId, accountId } = await seedAccount(1_000_000n);

    const ok = await holdCredits(db, accountId, 100_000n, tenantId);

    expect(ok).toBe(true);
    expect(await readAccount(accountId)).toEqual({ balance: 1_000_000n, held: 100_000n });
  });
});

// 批次6 D4: `ledger_txn.job_id` lost its FK when mig 0072 dropped the old
// `job` table — the column survives as PLAIN-uuid historical attribution.
describe('ledger_txn.job_id plain-uuid attribution (批次6 D4)', () => {
  it('accepts a ledger row whose job_id resolves to no live row (no FK)', async () => {
    const { tenantId, accountId } = await seedAccount(1_000_000n);
    const legacyJob = '99999999-9999-9999-9999-999999999999';

    await appendLedger(db, {
      tenantId,
      accountId,
      type: 'settle',
      creditsDelta: -1n,
      balanceAfter: 999_999n,
      jobId: legacyJob,
    });

    const rows = await client<
      { job_id: string | null }[]
    >`SELECT job_id FROM ledger_txn WHERE account_id = ${accountId} AND type = 'settle'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toBe(legacyJob);
  });
});

describe('releaseHold', () => {
  it('decrements credit_held', async () => {
    const { accountId } = await seedAccount(1_000_000n);
    await holdCredits(db, accountId, 400_000n);

    await releaseHold(db, accountId, 400_000n);

    expect(await readAccount(accountId)).toEqual({ balance: 1_000_000n, held: 0n });
  });
});

describe('appendLedger', () => {
  it('inserts a ledger_txn row with the supplied fields', async () => {
    const { tenantId, accountId } = await seedAccount(1_000_000n);

    await appendLedger(db, {
      tenantId,
      accountId,
      type: 'hold',
      creditsDelta: -400_000n,
      balanceAfter: 1_000_000n,
      jobId: null,
    });

    const rows = await db.select().from(ledgerTxn).where(eq(ledgerTxn.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('hold');
    expect(rows[0]?.creditsDelta).toBe(-400_000n);
    expect(rows[0]?.balanceAfter).toBe(1_000_000n);
  });
});

describe('topUp', () => {
  it('credits the balance and writes a topup ledger row in one transaction', async () => {
    const { tenantId, accountId } = await seedAccount(1_000_000n);

    const balanceAfter = await topUp(db, accountId, tenantId, 500_000n);

    expect(balanceAfter).toBe(1_500_000n);
    expect(await readAccount(accountId)).toEqual({ balance: 1_500_000n, held: 0n });

    const rows = await db.select().from(ledgerTxn).where(eq(ledgerTxn.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('topup');
    expect(rows[0]?.creditsDelta).toBe(500_000n);
    expect(rows[0]?.balanceAfter).toBe(1_500_000n);
  });
});
