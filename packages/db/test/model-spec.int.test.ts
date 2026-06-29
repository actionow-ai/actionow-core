import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getModelSpec, listModelSpecs, upsertModelSpec } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

/**
 * `model_spec` catalog repository (mig 0059). Verifies the partial-unique upsert
 * is idempotent (re-run = UPDATE, not a duplicate or 42P10), the vendor/type
 * filters compose, and the `(vendor, model_id)` get works.
 */

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
  await client`TRUNCATE TABLE model_spec RESTART IDENTITY CASCADE`;
});

describe('model_spec repository', () => {
  it('upsertModelSpec inserts a row with all fields', async () => {
    const row = await upsertModelSpec(db, {
      vendor: 'openai',
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5',
      type: 'text',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      keyParams: ['temperature'],
      sources: ['https://developers.openai.com/api/docs/pricing'],
      status: 'GA',
      contextWindow: '400k',
      intro: 'flagship',
      confidence: 'firstparty',
      billingEligible: true,
      asOf: '2026-06',
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    });
    expect(row.vendor).toBe('openai');
    expect(row.modelId).toBe('gpt-5.5');
    expect(row.type).toBe('text');
    expect(row.confidence).toBe('firstparty');
    expect(row.billingEligible).toBe(true);
    expect(row.inputModalities).toEqual(['text', 'image']);
  });

  it('upsertModelSpec is idempotent on the partial unique (re-run = UPDATE, no dup / no 42P10)', async () => {
    await upsertModelSpec(db, {
      vendor: 'openai',
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5',
      type: 'text',
      confidence: 'firstparty',
      billingEligible: true,
    });
    // Re-run with a changed displayName + intro — must UPDATE the same row.
    const updated = await upsertModelSpec(db, {
      vendor: 'openai',
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5 (updated)',
      type: 'text',
      intro: 'now with an intro',
      confidence: 'firstparty',
      billingEligible: true,
    });
    expect(updated.displayName).toBe('GPT-5.5 (updated)');
    expect(updated.intro).toBe('now with an intro');

    const all = await client`SELECT count(*)::int AS n FROM model_spec`;
    expect(all[0]?.n).toBe(1);
  });

  it('listModelSpecs filters by vendor and by type', async () => {
    await upsertModelSpec(db, { vendor: 'openai', modelId: 'gpt-5.5', type: 'text' });
    await upsertModelSpec(db, { vendor: 'openai', modelId: 'sora-2', type: 'video' });
    await upsertModelSpec(db, { vendor: 'anthropic', modelId: 'claude-opus-4-8', type: 'text' });

    const byVendor = await listModelSpecs(db, { vendor: 'openai' }, { limit: 50 });
    expect(byVendor.rows.map((r) => r.modelId).sort()).toEqual(['gpt-5.5', 'sora-2']);

    const byType = await listModelSpecs(db, { type: 'text' }, { limit: 50 });
    expect(byType.rows.map((r) => r.modelId).sort()).toEqual(['claude-opus-4-8', 'gpt-5.5']);

    const both = await listModelSpecs(db, { vendor: 'openai', type: 'video' }, { limit: 50 });
    expect(both.rows.map((r) => r.modelId)).toEqual(['sora-2']);
  });

  it('getModelSpec returns the live row by (vendor, modelId), undefined when absent', async () => {
    await upsertModelSpec(db, { vendor: 'openai', modelId: 'gpt-5.5', type: 'text' });
    const hit = await getModelSpec(db, 'openai', 'gpt-5.5');
    expect(hit?.modelId).toBe('gpt-5.5');
    expect(await getModelSpec(db, 'openai', 'nope')).toBeUndefined();
    expect(await getModelSpec(db, 'anthropic', 'gpt-5.5')).toBeUndefined();
  });

  it('rejects a type / confidence outside the CHECK allow-list', async () => {
    await expect(
      client`INSERT INTO model_spec (vendor, model_id, type) VALUES ('openai', 'x', 'banana')`,
    ).rejects.toThrow();
    await expect(
      client`INSERT INTO model_spec (vendor, model_id, type, confidence) VALUES ('openai', 'y', 'text', 'rumor')`,
    ).rejects.toThrow();
  });
});
