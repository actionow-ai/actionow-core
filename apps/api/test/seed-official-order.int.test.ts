import { schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedAll } from '../src/seed/seed.js';
import { seedOfficialPrices } from '../src/seed/seed-official-prices.js';
import { seedProviders } from '../src/seed/seed-providers.js';

/**
 * Verifies the PRODUCTION seed ORDER + the billing-safety fixes together on a
 * fresh db: official prices are seeded BEFORE the provider channels, so a chat
 * model with a verified official price is created `active` at that price, while a
 * model with no verified price is NEVER shipped `active` at a fake near-free rate.
 * Runs the exact order `main()` uses: seedAll → seedOfficialPrices → seedProviders.
 */
let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
  // Exact production order (apps/api/src/seed/seed.ts main()).
  const { tenantId } = await seedAll(db, { providerType: 'stub', seedDemoData: false });
  await seedOfficialPrices(db);
  await seedProviders(db, { tenantId });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

async function modelByName(name: string): Promise<typeof schema.model.$inferSelect | undefined> {
  const [row] = await db.select().from(schema.model).where(eq(schema.model.name, name)).limit(1);
  return row;
}

describe('production seed order → verified pricing, no fake near-free models', () => {
  it('prices the Xiaomi MiMo channel from its web-verified official price ($0.14/$0.28), active', async () => {
    const mimo = await modelByName('mimo-v2.5');
    expect(mimo?.status).toBe('active');
    expect(mimo?.inputPrice).toBe(140_000n);
    expect(mimo?.outputPrice).toBe(280_000n);
  });

  it('seeds the verified MiMo official price as a billable firstparty row', async () => {
    const [row] = await db
      .select()
      .from(schema.officialModelPrice)
      .where(
        and(
          eq(schema.officialModelPrice.provider, 'xiaomi'),
          eq(schema.officialModelPrice.modelSlug, 'mimo-v2.5'),
        ),
      )
      .limit(1);
    expect(row?.inputPricePer1m).toBe(140_000n);
    expect(row?.outputPricePer1m).toBe(280_000n);
    expect(row?.confidence).toBe('firstparty');
    expect(row?.billingEligible).toBe(true);
    // The verification date is stamped as `effective_at` (not left NULL).
    expect(row?.effectiveAt).not.toBeNull();
  });

  it('prices the legacy gpt-4o-mini channel from the verified DRAFT official price, active', async () => {
    // gpt-4o-mini is NOT in the firstparty catalog; its price comes only from the
    // web-verified seed-official-prices row. Because official prices are seeded
    // BEFORE providers, the direct channel picks it up and is active (not disabled).
    const mini = await modelByName('gpt-4o-mini');
    expect(mini?.status).toBe('active');
    expect(mini?.inputPrice).toBe(150_000n);
    expect(mini?.outputPrice).toBe(600_000n);
  });

  it('never ships a chat model public+active at the old fake 1 µUSD/1M price', async () => {
    const rows = await db.select().from(schema.model).where(eq(schema.model.status, 'active'));
    for (const m of rows) {
      const fake = m.inputPrice === 1n && m.outputPrice === 1n;
      expect(fake, `${m.name} is active at the fake 1n/1n price`).toBe(false);
    }
  });
});
