import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  claimRedemptionCode,
  createRedemptionCode,
  getRedemptionCode,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant } = schema;

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
  await client`TRUNCATE TABLE redemption_code, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(name = 'acme'): Promise<string> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('redemption_code repository', () => {
  it('createRedemptionCode inserts an unused code with bigint credit preserved', async () => {
    const row = await createRedemptionCode(db, { code: 'GIFT-1', creditAmount: 5_000_000n });
    expect(row.status).toBe('unused');
    expect(row.creditAmount).toBe(5_000_000n);
  });

  it('claimRedemptionCode flips unused→redeemed exactly once', async () => {
    const tenantId = await makeTenant();
    await createRedemptionCode(db, { code: 'GIFT-2', creditAmount: 1_000_000n });

    const first = await claimRedemptionCode(db, 'GIFT-2', tenantId);
    expect(first.claimed).toBe(true);
    expect(first.creditAmount).toBe(1_000_000n);

    // A second claim of the SAME code by the same tenant is a no-op (idempotent).
    const second = await claimRedemptionCode(db, 'GIFT-2', tenantId);
    expect(second.claimed).toBe(false);
    expect(second.alreadyRedeemedBy).toBe(tenantId);

    const after = await getRedemptionCode(db, 'GIFT-2');
    expect(after?.status).toBe('redeemed');
    expect(after?.redeemedByTenant).toBe(tenantId);
  });

  it('claimRedemptionCode reports an unknown code as not-claimed, missing', async () => {
    const tenantId = await makeTenant();
    const r = await claimRedemptionCode(db, 'NOPE', tenantId);
    expect(r.claimed).toBe(false);
    expect(r.missing).toBe(true);
  });

  it('claimRedemptionCode refuses an expired code', async () => {
    const tenantId = await makeTenant();
    await createRedemptionCode(db, {
      code: 'OLD',
      creditAmount: 1n,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await claimRedemptionCode(db, 'OLD', tenantId);
    expect(r.claimed).toBe(false);
    expect(r.expired).toBe(true);
  });

  // ── multi-use (mig 0067) ──────────────────────────────────────────────────
  it('createRedemptionCode stores max_uses (default 1, or explicit) with 0 redeemed', async () => {
    const single = await createRedemptionCode(db, { code: 'S', creditAmount: 1n });
    expect(single.maxUses).toBe(1);
    expect(single.redeemedCount).toBe(0);

    const multi = await createRedemptionCode(db, { code: 'M', creditAmount: 1n, maxUses: 5 });
    expect(multi.maxUses).toBe(5);
    expect(multi.redeemedCount).toBe(0);
  });

  it('a multi-use code is claimable by max_uses distinct tenants, then exhausted', async () => {
    await createRedemptionCode(db, { code: 'TEAM', creditAmount: 2_000_000n, maxUses: 3 });
    const tenants = await Promise.all([
      makeTenant('t1'),
      makeTenant('t2'),
      makeTenant('t3'),
      makeTenant('t4'),
    ]);

    for (const t of tenants.slice(0, 3)) {
      const r = await claimRedemptionCode(db, 'TEAM', t);
      expect(r.claimed).toBe(true);
      expect(r.creditAmount).toBe(2_000_000n);
    }

    const exhaustedRow = await getRedemptionCode(db, 'TEAM');
    expect(exhaustedRow?.redeemedCount).toBe(3);
    expect(exhaustedRow?.status).toBe('redeemed'); // 3/3 → exhausted

    const fourth = await claimRedemptionCode(db, 'TEAM', tenants[3]);
    expect(fourth.claimed).toBe(false);
    expect(fourth.exhausted).toBe(true);
  });

  it('status stays unused until the LAST use is consumed', async () => {
    await createRedemptionCode(db, { code: 'M2', creditAmount: 1n, maxUses: 2 });
    const t1 = await makeTenant('a');
    const t2 = await makeTenant('b');

    await claimRedemptionCode(db, 'M2', t1);
    const mid = await getRedemptionCode(db, 'M2');
    expect(mid?.redeemedCount).toBe(1);
    expect(mid?.status).toBe('unused'); // 1/2 → still claimable

    await claimRedemptionCode(db, 'M2', t2);
    const done = await getRedemptionCode(db, 'M2');
    expect(done?.redeemedCount).toBe(2);
    expect(done?.status).toBe('redeemed'); // 2/2
  });

  it('a tenant cannot consume a multi-use code more than once', async () => {
    await createRedemptionCode(db, { code: 'ONCE', creditAmount: 1n, maxUses: 5 });
    const t1 = await makeTenant('solo');

    const first = await claimRedemptionCode(db, 'ONCE', t1);
    expect(first.claimed).toBe(true);

    const again = await claimRedemptionCode(db, 'ONCE', t1);
    expect(again.claimed).toBe(false);
    expect(again.alreadyClaimedByThisTenant).toBe(true);

    // Only ONE use consumed despite two attempts by the same tenant.
    const row = await getRedemptionCode(db, 'ONCE');
    expect(row?.redeemedCount).toBe(1);
    expect(row?.status).toBe('unused'); // 1/5 → still open to OTHER tenants
  });
});
