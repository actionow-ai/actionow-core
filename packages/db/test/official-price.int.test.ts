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
});
