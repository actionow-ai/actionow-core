import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSubAccount,
  createSubject,
  getSubAccount,
  holdSubAccount,
  releaseSubAccountHold,
  settleSubAccount,
  topupSubAccount,
  transferCredits,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, ledgerTxn, subAccount, tenant } = schema;

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
  await client`TRUNCATE TABLE ledger_txn, sub_account, subject, account, tenant RESTART IDENTITY CASCADE`;
});

interface Seed {
  tenantId: string;
  accountId: string;
  subjectId: string;
}

async function seed(poolBalance: bigint, subBalance: bigint): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: poolBalance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account');
  const subj = await createSubject(db, { tenantId: t.id, externalId: 'u1' });
  await createSubAccount(db, { tenantId: t.id, subjectId: subj.id, creditBalance: subBalance });
  return { tenantId: t.id, accountId: a.id, subjectId: subj.id };
}

async function readSub(s: Seed): Promise<{ balance: bigint; held: bigint }> {
  const sub = await getSubAccount(db, s.tenantId, s.subjectId);
  if (sub === undefined) throw new Error('sub_account not found');
  return { balance: sub.creditBalance, held: sub.creditHeld };
}

async function readPool(accountId: string): Promise<bigint> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account');
  return a.creditBalance;
}

describe('holdSubAccount (no-oversell)', () => {
  it('holds when sufficient and refuses to oversell', async () => {
    const s = await seed(0n, 1_000_000n);
    const sub = await getSubAccount(db, s.tenantId, s.subjectId);
    const id = sub?.id ?? '';

    expect(await holdSubAccount(db, id, 600_000n)).toBe(true);
    expect(await readSub(s)).toEqual({ balance: 1_000_000n, held: 600_000n });
    // only 400k available now → a 600k hold must fail (no oversell)
    expect(await holdSubAccount(db, id, 600_000n)).toBe(false);
    expect(await readSub(s)).toEqual({ balance: 1_000_000n, held: 600_000n });
  });

  it('refuses a hold on a disabled sub-wallet', async () => {
    const s = await seed(0n, 1_000_000n);
    const sub = await getSubAccount(db, s.tenantId, s.subjectId);
    await db
      .update(subAccount)
      .set({ status: 'disabled' })
      .where(eq(subAccount.id, sub?.id ?? ''));
    expect(await holdSubAccount(db, sub?.id ?? '', 100_000n)).toBe(false);
  });
});

describe('settleSubAccount', () => {
  it('releases the hold and debits the final cost', async () => {
    const s = await seed(0n, 1_000_000n);
    const sub = await getSubAccount(db, s.tenantId, s.subjectId);
    const id = sub?.id ?? '';
    await holdSubAccount(db, id, 500_000n);

    const balanceAfter = await settleSubAccount(db, id, 500_000n, 300_000n);
    expect(balanceAfter).toBe(700_000n);
    expect(await readSub(s)).toEqual({ balance: 700_000n, held: 0n });
  });

  it('releaseSubAccountHold returns held credits without charging', async () => {
    const s = await seed(0n, 1_000_000n);
    const sub = await getSubAccount(db, s.tenantId, s.subjectId);
    const id = sub?.id ?? '';
    await holdSubAccount(db, id, 500_000n);
    await releaseSubAccountHold(db, id, 500_000n);
    expect(await readSub(s)).toEqual({ balance: 1_000_000n, held: 0n });
  });
});

describe('topupSubAccount', () => {
  it('credits the sub-wallet and writes a subject-attributed topup ledger row', async () => {
    const s = await seed(0n, 0n);
    const newBalance = await topupSubAccount(db, s.tenantId, s.subjectId, 250_000n);
    expect(newBalance).toBe(250_000n);
    expect((await readSub(s)).balance).toBe(250_000n);

    const ledger = await db.select().from(ledgerTxn);
    const topup = ledger.find((l) => l.type === 'topup');
    expect(topup?.subjectId).toBe(s.subjectId);
    expect(topup?.creditsDelta).toBe(250_000n);
    expect(topup?.balanceAfter).toBe(250_000n);
  });
});

describe('transferCredits (same-tenant, two ledger rows)', () => {
  it('moves credits tenant pool → sub-wallet', async () => {
    const s = await seed(1_000_000n, 0n);
    await transferCredits(db, {
      tenantId: s.tenantId,
      subjectId: s.subjectId,
      amount: 400_000n,
      direction: 'to_subject',
    });
    expect(await readPool(s.accountId)).toBe(600_000n);
    expect((await readSub(s)).balance).toBe(400_000n);

    const types = (await db.select().from(ledgerTxn)).map((l) => l.type).sort();
    expect(types).toEqual(['transfer_in', 'transfer_out']);
  });

  it('moves credits sub-wallet → tenant pool', async () => {
    const s = await seed(0n, 500_000n);
    await transferCredits(db, {
      tenantId: s.tenantId,
      subjectId: s.subjectId,
      amount: 200_000n,
      direction: 'to_tenant',
    });
    expect((await readSub(s)).balance).toBe(300_000n);
    expect(await readPool(s.accountId)).toBe(200_000n);
  });

  it('rejects a transfer that would overdraw the source (rolls back)', async () => {
    const s = await seed(100_000n, 0n);
    await expect(
      transferCredits(db, {
        tenantId: s.tenantId,
        subjectId: s.subjectId,
        amount: 500_000n,
        direction: 'to_subject',
      }),
    ).rejects.toThrow();
    // nothing moved, no ledger rows
    expect(await readPool(s.accountId)).toBe(100_000n);
    expect((await readSub(s)).balance).toBe(0n);
    expect(await db.select().from(ledgerTxn)).toHaveLength(0);
  });
});
