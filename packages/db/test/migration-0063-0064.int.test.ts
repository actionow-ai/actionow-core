import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createResource,
  freezeParamProfile,
  getModelByName,
  getModelSpec,
  updateModelSpec,
  upsertModelsFromSync,
  upsertModelSpec,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

/**
 * migs 0063 (model_spec.features/parameter_rules) + 0064 (model.param_profile),
 * plus the freeze-from-model_spec path in upsertModelsFromSync (模型参数绑定 Phase 1).
 * Mirrors the migration-0062 + model.int test harnesses.
 */
const { tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE model, model_spec, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

async function column(
  table: string,
  col: string,
): Promise<{ data_type: string; is_nullable: string } | undefined> {
  const rows = await client<{ data_type: string; is_nullable: string }[]>`
    SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${col}
  `;
  return rows[0];
}

async function makeChatResource(id: string): Promise<string> {
  const [t] = await db
    .insert(tenant)
    .values({ name: `owner-${id}` })
    .returning();
  if (!t) throw new Error('tenant insert returned no row');
  await createResource(db, {
    id,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  return id;
}

describe('migration 0063 — model_spec.features + parameter_rules', () => {
  // I1-1
  it('adds nullable jsonb features + parameter_rules; key_params stays (compat)', async () => {
    const feats = await column('model_spec', 'features');
    const rules = await column('model_spec', 'parameter_rules');
    const keyParams = await column('model_spec', 'key_params');
    expect(feats?.data_type).toBe('jsonb');
    expect(feats?.is_nullable).toBe('YES');
    expect(rules?.data_type).toBe('jsonb');
    expect(rules?.is_nullable).toBe('YES');
    expect(keyParams, 'key_params compat column still present').toBeDefined();
  });

  // I1-3
  it('upsertModelSpec round-trips parameterRules + features', async () => {
    const row = await upsertModelSpec(db, {
      vendor: 'openai',
      modelId: 'o5',
      type: 'text',
      features: ['tool-call', 'reasoning'],
      parameterRules: [{ name: 'temperature', useTemplate: 'temperature' }],
    });
    expect(row.features).toEqual(['tool-call', 'reasoning']);
    expect(row.parameterRules).toEqual([{ name: 'temperature', useTemplate: 'temperature' }]);
    // update clears them with null.
    const cleared = await updateModelSpec(db, row.id, { features: null, parameterRules: null });
    expect(cleared?.features).toBeNull();
    expect(cleared?.parameterRules).toBeNull();
  });
});

describe('migration 0064 — model.param_profile', () => {
  // I1-2
  it('adds a nullable jsonb model.param_profile', async () => {
    const c = await column('model', 'param_profile');
    expect(c?.data_type).toBe('jsonb');
    expect(c?.is_nullable).toBe('YES');
  });
});

describe('freezeParamProfile helper', () => {
  it('null spec / empty spec → null (passthrough); non-empty → snapshot', () => {
    expect(freezeParamProfile(undefined)).toBeNull();
    expect(freezeParamProfile({ features: [], parameterRules: [] })).toBeNull();
    expect(freezeParamProfile({ features: null, parameterRules: null })).toBeNull();
    expect(
      freezeParamProfile({
        features: ['reasoning'],
        parameterRules: [{ name: 'temperature' }],
      }),
    ).toEqual({
      features: ['reasoning'],
      parameterRules: [{ name: 'temperature' }],
      dropPolicy: 'passthrough',
    });
  });
});

describe('upsertModelsFromSync freezes param_profile from model_spec (D1)', () => {
  // I1-4
  it('freezes a matched spec onto model.param_profile on the NEW-model insert', async () => {
    const resourceId = await makeChatResource('r-freeze');
    // 规格库 spec keyed by (vendor=provider, model_id=slug the sync sends).
    await upsertModelSpec(db, {
      vendor: 'openai',
      modelId: 'gpt-x',
      type: 'text',
      features: ['tool-call'],
      parameterRules: [{ name: 'temperature', useTemplate: 'temperature' }],
    });
    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      defaultInputPrice: 1_000_000n,
      defaultOutputPrice: 2_000_000n,
      models: [{ name: 'gpt-x' }],
    });
    const m = await getModelByName(db, 'gpt-x');
    expect(m?.paramProfile).toEqual({
      features: ['tool-call'],
      parameterRules: [{ name: 'temperature', useTemplate: 'temperature' }],
      dropPolicy: 'passthrough',
    });
  });

  // I1-4b: no spec → param_profile stays null (passthrough == today).
  it('leaves param_profile null when no spec matches', async () => {
    const resourceId = await makeChatResource('r-nospec');
    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      defaultInputPrice: 1_000_000n,
      defaultOutputPrice: 2_000_000n,
      models: [{ name: 'gpt-unmatched' }],
    });
    const m = await getModelByName(db, 'gpt-unmatched');
    expect(m?.paramProfile).toBeNull();
  });

  // I1-5: existing-model re-sync PRESERVES the frozen/operator profile.
  it('re-sync preserves an existing model param_profile (no overwrite)', async () => {
    const resourceId = await makeChatResource('r-preserve');
    await upsertModelSpec(db, {
      vendor: 'openai',
      modelId: 'gpt-keep',
      type: 'text',
      features: ['reasoning'],
    });
    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      defaultInputPrice: 1n,
      defaultOutputPrice: 1n,
      models: [{ name: 'gpt-keep' }],
    });
    const before = await getModelByName(db, 'gpt-keep');
    expect(before?.paramProfile).not.toBeNull();

    // Change the spec, re-sync → the existing model row's profile is untouched.
    const spec = await getModelSpec(db, 'openai', 'gpt-keep');
    expect(spec).toBeDefined();
    await updateModelSpec(db, spec?.id ?? '', { features: ['tool-call', 'vision'] });
    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      models: [{ name: 'gpt-keep' }],
    });
    const after = await getModelByName(db, 'gpt-keep');
    expect(after?.paramProfile).toEqual(before?.paramProfile); // preserved
  });

  // I1-7: append-only clearance — a param_profile UPDATE is allowed on `model`.
  it('allows a param_profile UPDATE on model (no mig-0052 trigger blocks it)', async () => {
    const resourceId = await makeChatResource('r-update');
    await upsertModelsFromSync(db, {
      resourceId,
      provider: 'openai',
      defaultInputPrice: 1n,
      defaultOutputPrice: 1n,
      models: [{ name: 'gpt-upd' }],
    });
    const m = await getModelByName(db, 'gpt-upd');
    expect(m).toBeDefined();
    await db
      .update(schema.model)
      .set({ paramProfile: { features: ['reasoning'], parameterRules: [], dropPolicy: 'drop' } })
      .where(eq(schema.model.id, m?.id ?? ''));
    const after = await getModelByName(db, 'gpt-upd');
    expect(after?.paramProfile).toEqual({
      features: ['reasoning'],
      parameterRules: [],
      dropPolicy: 'drop',
    });
  });
});
