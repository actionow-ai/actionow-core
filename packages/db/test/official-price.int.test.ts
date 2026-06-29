import type { PriceSpec } from '@actionow/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createOfficialPrice,
  getOfficialPrice,
  getOfficialPriceById,
  listOfficialPrices,
  matchOfficialPrice,
  normalizeModelSlug,
  officialPriceToSpec,
  softDeleteOfficialPrice,
  updateOfficialPrice,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

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
  await client`TRUNCATE TABLE official_model_price RESTART IDENTITY CASCADE`;
});

describe('normalizeModelSlug (pure)', () => {
  it('lowercases the slug', () => {
    expect(normalizeModelSlug('GPT-4O')).toBe('gpt-4o');
  });

  it('strips a trailing -YYYY-MM-DD date suffix', () => {
    expect(normalizeModelSlug('gpt-4o-2024-05-13')).toBe('gpt-4o');
    expect(normalizeModelSlug('claude-3-5-sonnet-2024-10-22')).toBe('claude-3-5-sonnet');
  });

  it('does NOT strip a version that is not a full date suffix', () => {
    // a bare year or a partial date is left intact (only -YYYY-MM-DD is a suffix)
    expect(normalizeModelSlug('gpt-4o-2024')).toBe('gpt-4o-2024');
    expect(normalizeModelSlug('gpt-4o-2024-05')).toBe('gpt-4o-2024-05');
  });

  it('applies the alias map (e.g. chatgpt-4o-latest → gpt-4o)', () => {
    expect(normalizeModelSlug('chatgpt-4o-latest')).toBe('gpt-4o');
  });

  it('combines case + date strip + alias', () => {
    expect(normalizeModelSlug('GPT-4O-2024-05-13')).toBe('gpt-4o');
  });
});

describe('official price CRUD', () => {
  it('creates, fetches by id, and lists newest-first (paginated)', async () => {
    const a = await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      displayName: 'GPT-4o',
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
    });
    const b = await createOfficialPrice(db, {
      provider: 'anthropic',
      modelSlug: 'claude-3-5-sonnet',
      inputPricePer1m: 3_000_000n,
      outputPricePer1m: 15_000_000n,
    });

    const byId = await getOfficialPriceById(db, a.id);
    expect(byId?.modelSlug).toBe('gpt-4o');
    expect(byId?.inputPricePer1m).toBe(2_500_000n);

    const { rows } = await listOfficialPrices(db, {}, { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]); // newest-first

    const filtered = await listOfficialPrices(db, { provider: 'openai' }, { limit: 50 });
    expect(filtered.rows.map((r) => r.modelSlug)).toEqual(['gpt-4o']);
  });

  it('updates mutable fields and bumps updated_at', async () => {
    const row = await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o-mini',
      inputPricePer1m: 150_000n,
      outputPricePer1m: 600_000n,
    });
    const updated = await updateOfficialPrice(db, row.id, {
      outputPricePer1m: 700_000n,
      notes: 'bumped',
      updatedBy: 'admin@x',
    });
    expect(updated?.outputPricePer1m).toBe(700_000n);
    expect(updated?.inputPricePer1m).toBe(150_000n); // untouched
    expect(updated?.notes).toBe('bumped');
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
  });

  it('soft-deletes (drops from get/list/match) and allows re-create of the pair', async () => {
    const row = await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
    });

    const deletedId = await softDeleteOfficialPrice(db, row.id);
    expect(deletedId).toBe(row.id);

    // get/list/match all filter deleted_at IS NULL.
    expect(await getOfficialPriceById(db, row.id)).toBeUndefined();
    expect(await getOfficialPrice(db, 'openai', 'gpt-4o')).toBeUndefined();
    expect((await listOfficialPrices(db, {}, { limit: 50 })).rows).toHaveLength(0);

    // PARTIAL unique frees the (provider, slug) pair → a re-create yields a NEW row.
    const recreated = await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      inputPricePer1m: 9_999_999n,
      outputPricePer1m: 9_999_999n,
    });
    expect(recreated.id).not.toBe(row.id);
    const live = await getOfficialPrice(db, 'openai', 'gpt-4o');
    expect(live?.id).toBe(recreated.id);
    expect(live?.inputPricePer1m).toBe(9_999_999n);
  });
});

describe('matchOfficialPrice', () => {
  it('looks up the normalized slug for a provider (date strip + case)', async () => {
    await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
    });

    // raw upstream slug with a date suffix + uppercase → normalizes to the stored slug.
    const matched = await matchOfficialPrice(db, 'openai', 'GPT-4o-2024-05-13');
    expect(matched?.inputPricePer1m).toBe(2_500_000n);

    // wrong provider → no match.
    expect(await matchOfficialPrice(db, 'anthropic', 'gpt-4o')).toBeUndefined();
    // unknown slug → no match.
    expect(await matchOfficialPrice(db, 'openai', 'gpt-9-ultra')).toBeUndefined();
  });

  it('NEVER auto-prices a needs-review (billing_eligible=false) row (defense-in-depth)', async () => {
    // A catalog-only row (e.g. a reconstructed video price) is present but not
    // billable — the matcher must return undefined even though the row exists.
    await createOfficialPrice(db, {
      provider: 'kling',
      modelSlug: 'kling-v3-0',
      inputPricePer1m: 0n,
      outputPricePer1m: 0n,
      confidence: 'reconstructed',
      billingEligible: false,
    });
    expect(await getOfficialPrice(db, 'kling', 'kling-v3-0')).toBeUndefined();
    expect(await matchOfficialPrice(db, 'kling', 'kling-v3-0')).toBeUndefined();

    // The same row flipped eligible DOES match.
    await createOfficialPrice(db, {
      provider: 'kling',
      modelSlug: 'kling-pro',
      inputPricePer1m: 5n,
      outputPricePer1m: 9n,
      billingEligible: true,
    });
    expect((await matchOfficialPrice(db, 'kling', 'kling-pro'))?.inputPricePer1m).toBe(5n);
  });

  it('persists currency / confidence / billingEligible governance columns', async () => {
    const row = await createOfficialPrice(db, {
      provider: 'deepseek',
      modelSlug: 'deepseek-chat',
      inputPricePer1m: 270_000n,
      outputPricePer1m: 1_100_000n,
      currency: 'USD',
      confidence: 'firstparty',
      billingEligible: true,
    });
    expect(row.currency).toBe('USD');
    expect(row.confidence).toBe('firstparty');
    expect(row.billingEligible).toBe(true);
  });
});

describe('official_model_price.scheme (rich-media pricing storage)', () => {
  const creditsScheme: PriceSpec = {
    method: 'credits',
    creditValueMicroUsd: 10_000,
    baseCredits: 2,
    dimensions: { duration_seconds: { credits: 1 } },
    addOns: [{ flag: 'audio', credits: 5 }],
  };

  it('defaults to null (a plain per-token row stores no scheme)', async () => {
    const row = await createOfficialPrice(db, {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
    });
    expect(row.scheme).toBeNull();
  });

  it('persists a full PriceSpec scheme (round-trips through the jsonb column)', async () => {
    const row = await createOfficialPrice(db, {
      provider: 'vidu',
      modelSlug: 'vidu-q1',
      inputPricePer1m: 0n,
      outputPricePer1m: 0n,
      scheme: creditsScheme,
    });
    expect(row.scheme).toEqual(creditsScheme);

    const refetched = await getOfficialPriceById(db, row.id);
    expect(refetched?.scheme).toEqual(creditsScheme);
  });

  it('update sets the scheme, and null clears it back to per-token', async () => {
    const row = await createOfficialPrice(db, {
      provider: 'kling',
      modelSlug: 'kling-pro',
      inputPricePer1m: 0n,
      outputPricePer1m: 0n,
    });
    expect(row.scheme).toBeNull();

    const set = await updateOfficialPrice(db, row.id, { scheme: creditsScheme });
    expect(set?.scheme).toEqual(creditsScheme);

    const cleared = await updateOfficialPrice(db, row.id, { scheme: null });
    expect(cleared?.scheme).toBeNull();
  });
});

describe('officialPriceToSpec (effective spec resolver)', () => {
  it('returns the stored scheme verbatim when present', () => {
    const scheme: PriceSpec = {
      method: 'credits',
      creditValueMicroUsd: 10_000,
      baseCredits: 0,
      dimensions: { frames: { credits: 3 } },
    };
    const spec = officialPriceToSpec({
      scheme,
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
      cachedInputPricePer1m: 1_250_000n,
    });
    expect(spec).toBe(scheme); // the stored scheme wins outright (ignores the columns)
  });

  it('synthesizes a model_token spec from the per-1M columns when scheme is null', () => {
    const spec = officialPriceToSpec({
      scheme: null,
      inputPricePer1m: 2_500_000n,
      outputPricePer1m: 10_000_000n,
      cachedInputPricePer1m: null,
    });
    expect(spec).toEqual({
      method: 'model_token',
      inputPrice: 2_500_000,
      outputPrice: 10_000_000,
    });
  });

  it('includes cachedInputPrice + groupRatioBps when present (null scheme)', () => {
    const spec = officialPriceToSpec(
      {
        scheme: null,
        inputPricePer1m: 2_500_000n,
        outputPricePer1m: 10_000_000n,
        cachedInputPricePer1m: 1_250_000n,
      },
      { groupRatioBps: 12_000 },
    );
    expect(spec).toEqual({
      method: 'model_token',
      inputPrice: 2_500_000,
      outputPrice: 10_000_000,
      cachedInputPrice: 1_250_000,
      groupRatioBps: 12_000,
    });
  });

  it('omits cachedInputPrice / groupRatioBps when absent (regression invariant: byte-identical model_token)', () => {
    // No cached column, no opts → exactly the pre-`scheme` model_token shape.
    const spec = officialPriceToSpec({
      scheme: null,
      inputPricePer1m: 150_000n,
      outputPricePer1m: 600_000n,
      cachedInputPricePer1m: null,
    });
    expect(Object.keys(spec).sort()).toEqual(['inputPrice', 'method', 'outputPrice']);
  });
});
