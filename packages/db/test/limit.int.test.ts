import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createLimitPlan,
  getLimitPlanById,
  getUsage,
  incrUsage,
  listLimitPlans,
  listRulesByPlan,
  listUsageForSubject,
  periodKeyFor,
  recordLimitAlert,
  replacePlanRules,
  resolveEffectiveRules,
  softDeleteLimitPlan,
  updateLimitPlan,
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
  await client`TRUNCATE TABLE limit_alert, limit_usage, limit_rule, limit_plan RESTART IDENTITY CASCADE`;
});

describe('limit_plan CRUD + rules', () => {
  it('creates, lists, updates, soft-deletes (frees name), and replaces rules', async () => {
    const plan = await createLimitPlan(db, { name: 'Pro', description: 'pro tier' });
    expect(plan.status).toBe('active');
    expect((await getLimitPlanById(db, plan.id))?.name).toBe('Pro');

    const updated = await updateLimitPlan(db, plan.id, { name: 'Pro+', status: 'disabled' });
    expect(updated?.name).toBe('Pro+');
    expect(updated?.status).toBe('disabled');

    // replace-all rules
    await replacePlanRules(db, plan.id, [
      { dimension: 'spend', period: 'month', cap: 5_000_000n, alertPct: 80 },
      { dimension: 'requests', period: 'day', cap: 1000n },
      { dimension: 'rpm', period: 'minute', cap: 60n },
    ]);
    let rules = await listRulesByPlan(db, plan.id);
    expect(rules).toHaveLength(3);
    expect(rules.find((r) => r.dimension === 'spend')?.cap).toBe(5_000_000n);
    expect(rules.find((r) => r.dimension === 'spend')?.alertPct).toBe(80);

    // replace again → old rules gone
    await replacePlanRules(db, plan.id, [{ dimension: 'tokens', period: 'total', cap: 9n }]);
    rules = await listRulesByPlan(db, plan.id);
    expect(rules.map((r) => r.dimension)).toEqual(['tokens']);

    // soft-delete frees the name
    expect(await softDeleteLimitPlan(db, plan.id)).toBe(plan.id);
    expect(await getLimitPlanById(db, plan.id)).toBeUndefined();
    expect((await listLimitPlans(db)).length).toBe(0);
    const recreated = await createLimitPlan(db, { name: 'Pro+' });
    expect(recreated.id).not.toBe(plan.id);
  });
});

describe('resolveEffectiveRules', () => {
  it('unions key + tenant active plans, excludes disabled/deleted, returns [] for no plan', async () => {
    const keyPlan = await createLimitPlan(db, { name: 'key-plan' });
    const tenantPlan = await createLimitPlan(db, { name: 'tenant-plan' });
    await replacePlanRules(db, keyPlan.id, [{ dimension: 'rpm', period: 'minute', cap: 30n }]);
    await replacePlanRules(db, tenantPlan.id, [
      { dimension: 'spend', period: 'month', cap: 1n },
      { dimension: 'requests', period: 'day', cap: 2n },
    ]);

    const both = await resolveEffectiveRules(db, keyPlan.id, tenantPlan.id);
    expect(both.map((r) => r.dimension).sort()).toEqual(['requests', 'rpm', 'spend']);

    // no plans bound → empty
    expect(await resolveEffectiveRules(db, null, null)).toHaveLength(0);

    // disabled plan contributes nothing
    await updateLimitPlan(db, tenantPlan.id, { status: 'disabled' });
    const onlyKey = await resolveEffectiveRules(db, keyPlan.id, tenantPlan.id);
    expect(onlyKey.map((r) => r.dimension)).toEqual(['rpm']);

    // soft-deleted plan contributes nothing
    await softDeleteLimitPlan(db, keyPlan.id);
    expect(await resolveEffectiveRules(db, keyPlan.id, tenantPlan.id)).toHaveLength(0);
  });
});

describe('usage accumulator + period keys', () => {
  it('upserts additively per bucket and reads back; period keys bucket by day/month/total', async () => {
    const key = {
      subjectType: 'tenant',
      subjectId: 't1',
      dimension: 'spend',
      periodKey: '2026-06',
    };
    expect(await getUsage(db, key)).toBe(0n);
    expect(await incrUsage(db, key, 100n)).toBe(100n);
    expect(await incrUsage(db, key, 50n)).toBe(150n);
    expect(await getUsage(db, key)).toBe(150n);

    // a different bucket is independent
    const other = { ...key, periodKey: '2026-07' };
    expect(await incrUsage(db, other, 7n)).toBe(7n);
    expect(await getUsage(db, key)).toBe(150n);

    // model_scope is part of the bucket key
    const scoped = { ...key, modelScope: 'gpt-5.5' };
    expect(await incrUsage(db, scoped, 9n)).toBe(9n);
    expect(await getUsage(db, key)).toBe(150n);

    expect((await listUsageForSubject(db, 'tenant', 't1')).length).toBe(3);

    const now = new Date('2026-06-24T12:00:00Z');
    expect(periodKeyFor('day', now)).toBe('2026-06-24');
    expect(periodKeyFor('month', now)).toBe('2026-06');
    expect(periodKeyFor('total', now)).toBe('total');
  });
});

describe('limit_alert idempotency', () => {
  it('records once per (subject, rule, period, pct)', async () => {
    const input = {
      subjectType: 'tenant',
      subjectId: 't1',
      ruleId: '00000000-0000-0000-0000-000000000001',
      dimension: 'spend',
      periodKey: '2026-06',
      used: 80n,
      cap: 100n,
      pct: 80,
    };
    const first = await recordLimitAlert(db, input);
    expect(first).toBeDefined();
    // same crossing again → no new row (onConflictDoNothing)
    const second = await recordLimitAlert(db, input);
    expect(second).toBeUndefined();
    // a different pct fires
    const third = await recordLimitAlert(db, { ...input, pct: 100, used: 100n });
    expect(third).toBeDefined();
  });
});
