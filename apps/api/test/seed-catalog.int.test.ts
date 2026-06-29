import { readFileSync } from 'node:fs';

import { matchOfficialPrice, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { importCatalog } from '../src/seed/seed-catalog.js';

/**
 * `importCatalog` (mig 0059) — imports the OFFICIAL normalized model catalog.
 * Asserts the full catalog lands in `model_spec` (counts + byConfidence match
 * the dataset), ONLY the billing-eligible rows enter `official_model_price`, a
 * non-eligible model is absent, `matchOfficialPrice` resolves an eligible model
 * and refuses a non-eligible one, and re-running is idempotent.
 *
 * The dataset is read directly here to derive the expected counts so the test
 * is self-validating against whatever the committed JSON says.
 */

// The committed dataset (read from the repo root; the api test cwd is apps/api).
const dataset = JSON.parse(
  readFileSync(
    new URL('../../../docs/research/official-model-catalog-normalized.json', import.meta.url),
    'utf8',
  ),
) as {
  models: { vendor: string; modelId: string; confidence: string; billingEligible: boolean }[];
  counts: {
    total: number;
    byConfidence: Record<string, number>;
    billingEligible: number;
  };
};

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE model_spec, official_model_price RESTART IDENTITY CASCADE`;
});

/** Count rows of `table` matching an optional raw `where` (SQL text, trusted in-test). */
async function count(table: string, where = ''): Promise<number> {
  const clause = where === '' ? client`` : client`WHERE ${client.unsafe(where)}`;
  const rows = await client<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM ${client(table)} ${clause}`;
  return rows[0]?.n ?? 0;
}

describe('importCatalog', () => {
  it('imports every model into model_spec with matching byConfidence counts', async () => {
    const result = await importCatalog(db);

    const expectedTotal = dataset.counts.total;
    const expectedFirstparty = dataset.counts.byConfidence.firstparty;
    expect(expectedTotal).toBe(236);
    expect(expectedFirstparty).toBe(48);

    expect(result.modelSpecs).toBe(expectedTotal);

    expect(await count('model_spec')).toBe(expectedTotal);

    // byConfidence must match the dataset's own declared counts.
    const conf = await client<{ confidence: string; n: number }[]>`
      SELECT confidence, count(*)::int AS n FROM model_spec GROUP BY confidence`;
    const byConfidence = Object.fromEntries(conf.map((r) => [r.confidence, r.n])) as Record<
      string,
      number
    >;
    expect(byConfidence).toEqual(dataset.counts.byConfidence);
    expect(byConfidence.firstparty).toBe(48);
  });

  it('only billing-eligible models enter official_model_price; a non-eligible one is absent', async () => {
    const result = await importCatalog(db);
    const expectedEligible = dataset.counts.billingEligible;
    expect(expectedEligible).toBe(48);

    expect(result.officialPrices).toBe(expectedEligible);
    expect(await count('official_model_price')).toBe(expectedEligible);

    // A known non-eligible Kling model is in model_spec but NOT in official_model_price.
    expect(await count('model_spec', "vendor='kling' AND model_id='kling-v3-0'")).toBe(1);
    expect(await count('official_model_price', "provider='kling'")).toBe(0);

    // Every official_model_price row is firstparty + billing-eligible.
    expect(
      await count(
        'official_model_price',
        "billing_eligible IS NOT TRUE OR confidence <> 'firstparty'",
      ),
    ).toBe(0);
  });

  it('matchOfficialPrice resolves openai gpt-5.5 (input 5_000_000) and refuses a non-eligible model', async () => {
    await importCatalog(db);

    const gpt = await matchOfficialPrice(db, 'openai', 'gpt-5.5');
    expect(gpt?.inputPricePer1m).toBe(5_000_000n);
    expect(gpt?.outputPricePer1m).toBe(30_000_000n);

    // A non-eligible model (catalog-only) never resolves a billable price.
    expect(await matchOfficialPrice(db, 'kling', 'kling-v3-0')).toBeUndefined();
  });

  it('is idempotent: re-running creates no duplicate rows', async () => {
    const first = await importCatalog(db);
    const second = await importCatalog(db);

    expect(second.modelSpecs).toBe(first.modelSpecs);
    expect(second.officialPrices).toBe(first.officialPrices);

    expect(await count('model_spec')).toBe(dataset.counts.total);
    expect(await count('official_model_price')).toBe(dataset.counts.billingEligible);
  });
});
