import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  accrueLimitUsage,
  createAccount,
  createLimitPlan,
  createTenant,
  getLimitPlanById,
  getLimitPlanForTenant,
  getUsage,
  incrUsage,
  listLimitAlerts,
  listLimitPlans,
  listLimitPlansByTenant,
  listRulesByPlan,
  listUsageForSubject,
  periodKeyFor,
  recordLimitAlert,
  replacePlanRules,
  resolveEffectiveRules,
  setTenantLimitPlan,
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
  await client`TRUNCATE TABLE limit_alert, limit_usage, limit_rule, limit_plan, account, tenant RESTART IDENTITY CASCADE`;
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

describe('tenant-owned limit plans (end-user data plane)', () => {
  it('persists tenant_id, scopes list/get to the tenant, and lets tenants reuse names', async () => {
    const tenantA = await createTenant(db, { name: 'tenant-a' });
    const tenantB = await createTenant(db, { name: 'tenant-b' });

    // create persists tenant_id
    const aPro = await createLimitPlan(db, { name: 'pro', tenantId: tenantA.id });
    expect(aPro.tenantId).toBe(tenantA.id);

    // two tenants may both have a plan named 'pro' (per-(tenant_id,name) unique)
    const bPro = await createLimitPlan(db, { name: 'pro', tenantId: tenantB.id });
    expect(bPro.tenantId).toBe(tenantB.id);
    expect(bPro.id).not.toBe(aPro.id);

    // a platform plan (tenant_id NULL) coexists with the tenant ones
    const platform = await createLimitPlan(db, { name: 'platform-pro' });
    expect(platform.tenantId).toBeNull();

    // listLimitPlansByTenant returns only that tenant's plans (not platform, not other tenant)
    const aPlans = await listLimitPlansByTenant(db, tenantA.id);
    expect(aPlans.map((p) => p.id)).toEqual([aPro.id]);
    const bPlans = await listLimitPlansByTenant(db, tenantB.id);
    expect(bPlans.map((p) => p.id)).toEqual([bPro.id]);

    // getLimitPlanForTenant returns the row only for its owning tenant; undefined otherwise
    expect((await getLimitPlanForTenant(db, aPro.id, tenantA.id))?.id).toBe(aPro.id);
    expect(await getLimitPlanForTenant(db, aPro.id, tenantB.id)).toBeUndefined();
    // a platform plan id is not a tenant's plan
    expect(await getLimitPlanForTenant(db, platform.id, tenantA.id)).toBeUndefined();
  });

  it('newest-first list order and excludes soft-deleted plans', async () => {
    const t = await createTenant(db, { name: 'tenant-order' });
    const first = await createLimitPlan(db, { name: 'first', tenantId: t.id });
    // bump createdAt so ordering is deterministic
    await client`UPDATE limit_plan SET created_at = now() + interval '1 second' WHERE id = ${first.id}`;
    const second = await createLimitPlan(db, { name: 'second', tenantId: t.id });

    let plans = await listLimitPlansByTenant(db, t.id);
    expect(plans.map((p) => p.id)).toEqual([first.id, second.id]);

    await softDeleteLimitPlan(db, first.id);
    plans = await listLimitPlansByTenant(db, t.id);
    expect(plans.map((p) => p.id)).toEqual([second.id]);
    expect(await getLimitPlanForTenant(db, first.id, t.id)).toBeUndefined();
  });

  // Pins the `limit_plan_tenant_name_idx` NULLS NOT DISTINCT semantics applied
  // by the hand-edited 0050 migration. drizzle-orm 0.45.2's index builder can't
  // express `.nullsNotDistinct()` and drizzle-kit 0.31.10's snapshot can't model
  // it, so the guarantee lives ONLY in raw SQL + is invisible to a future
  // `drizzle-kit generate`. This test fails loudly if a regen ever silently
  // drops it (instead of platform plans quietly allowing duplicate live names).
  it('platform plans (tenant_id NULL) are name-unique among themselves (NULLS NOT DISTINCT)', async () => {
    await createLimitPlan(db, { name: 'dup-platform' });
    // a second live platform plan with the same name must collide on the index
    await expect(createLimitPlan(db, { name: 'dup-platform' })).rejects.toThrow();
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

describe('accrueLimitUsage (settle accrual + alerts)', () => {
  it('accrues spend/tokens into the tenant plan bucket and fires the alert at threshold', async () => {
    const plan = await createLimitPlan(db, { name: 'budget' });
    await replacePlanRules(db, plan.id, [
      { dimension: 'spend', period: 'month', cap: 100n, alertPct: 80 },
      { dimension: 'tokens', period: 'total', cap: 1000n },
      { dimension: 'spend', period: 'rolling_24h', cap: 999n }, // rolling → NOT accrued
    ]);
    const tenant = await createTenant(db, { name: 't' });
    await createAccount(db, { tenantId: tenant.id });
    await setTenantLimitPlan(db, tenant.id, plan.id);

    const now = new Date('2026-06-24T12:00:00Z');
    await accrueLimitUsage(db, {
      tenantId: tenant.id,
      apiKeyId: null,
      model: 'm',
      cost: 80n,
      tokens: 300n,
      now,
    });
    expect(
      await getUsage(db, {
        subjectType: 'tenant',
        subjectId: tenant.id,
        dimension: 'spend',
        periodKey: '2026-06',
      }),
    ).toBe(80n);
    expect(
      await getUsage(db, {
        subjectType: 'tenant',
        subjectId: tenant.id,
        dimension: 'tokens',
        periodKey: 'total',
      }),
    ).toBe(300n);
    // rolling spend rule must NOT have materialized a bucket
    expect(
      await getUsage(db, {
        subjectType: 'tenant',
        subjectId: tenant.id,
        dimension: 'spend',
        periodKey: 'rolling_24h',
      }),
    ).toBe(0n);
    // spend 80 >= 80% of 100 → one alert
    expect((await listLimitAlerts(db)).length).toBe(1);

    // accrue more; alert stays idempotent for the 80% threshold
    await accrueLimitUsage(db, {
      tenantId: tenant.id,
      apiKeyId: null,
      model: 'm',
      cost: 30n,
      tokens: 0n,
      now,
    });
    expect(
      await getUsage(db, {
        subjectType: 'tenant',
        subjectId: tenant.id,
        dimension: 'spend',
        periodKey: '2026-06',
      }),
    ).toBe(110n);
    expect((await listLimitAlerts(db)).length).toBe(1);
  });

  it('is a no-op when neither key nor tenant has a plan', async () => {
    const tenant = await createTenant(db, { name: 't2' });
    await createAccount(db, { tenantId: tenant.id });
    await accrueLimitUsage(db, {
      tenantId: tenant.id,
      apiKeyId: null,
      model: 'm',
      cost: 50n,
      tokens: 9n,
    });
    expect((await listUsageForSubject(db, 'tenant', tenant.id)).length).toBe(0);
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
