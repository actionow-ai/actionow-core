import {
  createAccount,
  createRedemptionCode,
  getAccount,
  getAccountByTenant,
  schema,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { redeemCode } from '../src/redemption-service.js';

const { ledgerTxn, tenant } = schema;

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
  await client`TRUNCATE TABLE ledger_txn, redemption_code, account, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenantWithAccount(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  await createAccount(db, { tenantId: t.id, creditBalance: 0n });
  return t.id;
}

async function ledgerTypesFor(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ type: ledgerTxn.type })
    .from(ledgerTxn)
    .where(eq(ledgerTxn.tenantId, tenantId));
  return rows.map((r) => r.type);
}

async function balanceFor(tenantId: string): Promise<bigint | undefined> {
  const acct = await getAccountByTenant(db, tenantId);
  if (acct === undefined) return undefined;
  const full = await getAccount(db, acct.id);
  return full?.creditBalance;
}

describe('redeemCode', () => {
  it('credits the tenant account once and reports the new balance', async () => {
    const tenantId = await makeTenantWithAccount();
    await createRedemptionCode(db, { code: 'GIFT', creditAmount: 2_000_000n });

    const r = await redeemCode(db, 'GIFT', tenantId);
    expect(r.redeemed).toBe(true);
    expect(r.balance).toBe(2_000_000n);

    expect(await ledgerTypesFor(tenantId)).toEqual(['topup']);
  });

  it('is idempotent on a re-claim — no second credit', async () => {
    const tenantId = await makeTenantWithAccount();
    await createRedemptionCode(db, { code: 'GIFT2', creditAmount: 1_000_000n });

    const first = await redeemCode(db, 'GIFT2', tenantId);
    expect(first.redeemed).toBe(true);

    const second = await redeemCode(db, 'GIFT2', tenantId);
    expect(second.redeemed).toBe(false);
    expect(second.balance).toBeUndefined();

    expect(await balanceFor(tenantId)).toBe(1_000_000n);
    expect(await ledgerTypesFor(tenantId)).toEqual(['topup']);
  });

  it('rejects an unknown code with resource_not_found and credits nothing', async () => {
    const tenantId = await makeTenantWithAccount();

    await expect(redeemCode(db, 'NOPE', tenantId)).rejects.toThrow();

    expect(await balanceFor(tenantId)).toBe(0n);
    expect(await ledgerTypesFor(tenantId)).toEqual([]);
  });

  it('rejects an expired code without crediting', async () => {
    const tenantId = await makeTenantWithAccount();
    await createRedemptionCode(db, {
      code: 'OLD',
      creditAmount: 5_000_000n,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(redeemCode(db, 'OLD', tenantId)).rejects.toThrow();

    expect(await balanceFor(tenantId)).toBe(0n);
    expect(await ledgerTypesFor(tenantId)).toEqual([]);
  });

  it('errors when the tenant has no account', async () => {
    const [t] = await db.insert(tenant).values({ name: 'no-account' }).returning();
    if (!t) throw new Error('tenant insert returned no row');
    await createRedemptionCode(db, { code: 'ORPHAN', creditAmount: 3_000_000n });

    await expect(redeemCode(db, 'ORPHAN', t.id)).rejects.toThrow();
  });
});
