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
});
