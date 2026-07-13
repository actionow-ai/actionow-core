// model-supply-greenfield 批次6 P5b — the NEW-FACE settle's usage_log mirror +
// spend/tokens limit accrual (§9.1 层2 闭环), against REAL Postgres:
//
//   - settleGatewayTask with a `usageLog` envelope appends ONE usage_log row
//     (cost/provider_cost/model/route_tag/api_key/subject) and accrues the
//     call's spend/tokens into limit_usage for EVERY bound plan scope
//     (key ∪ tenant ∪ subject) — the same accrueLimitUsage the legacy settle
//     used, so the §7.8 read-only precheck (getUsage/windowedUsage) sees
//     new-face settles.
//   - idempotency: a replayed settle (transition no-op) accrues NOTHING —
//     the accrual rides INSIDE the guarded transaction.
//   - rolling windows: windowedUsage aggregates the new usage_log row for
//     spend/tokens/requests.
//   - no envelope → no usage row (legacy-caller compat).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createLimitPlan,
  createTask,
  getUsage,
  listLimitAlerts,
  replacePlanRules,
  settleGatewayTask,
  windowedUsage,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, apiKey, subject, tenant, usageLog } = schema;

/** Assert a fixture row (drizzle `.returning()` / index access is `T | undefined`) is present. */
function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined fixture row');
  return value;
}

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
  // TRUNCATE fires no row triggers, so the ledger/task-events append-only
  // triggers permit cleanup.
  await client`TRUNCATE TABLE usage_log, limit_alert, limit_usage, limit_rule, limit_plan,
    ledger_txn, task_events, task, subject, api_key, account, tenant RESTART IDENTITY CASCADE`;
});

interface Seed {
  tenantId: string;
  accountId: string;
  apiKeyId: string;
  subjectId: string;
  keyPlanId: string;
  tenantPlanId: string;
  subjectPlanId: string;
}

/**
 * Seed the full accrual surface: a funded tenant account, an api key and a
 * subject — EACH bound to its own limit plan (key: spend/day + tokens/total +
 * a rolling spend rule; tenant: spend/month with an 80% alert; subject:
 * spend/total). Caps are high enough that a single settle stays under them
 * unless a test says otherwise.
 */
async function seed(): Promise<Seed> {
  const t = req((await db.insert(tenant).values({ name: 'p5b-tenant' }).returning())[0]);

  const keyPlan = await createLimitPlan(db, { name: 'p5b-key-plan' });
  await replacePlanRules(db, keyPlan.id, [
    { dimension: 'spend', period: 'day', cap: 1_000_000n },
    { dimension: 'tokens', period: 'total', cap: 1_000_000n },
    // Rolling rules are NOT materialized — precheck reads them via usage_log.
    { dimension: 'spend', period: 'rolling_24h', cap: 1_000_000n },
  ]);
  const tenantPlan = await createLimitPlan(db, { name: 'p5b-tenant-plan' });
  await replacePlanRules(db, tenantPlan.id, [
    { dimension: 'spend', period: 'month', cap: 2_000n, alertPct: 80 },
  ]);
  const subjectPlan = await createLimitPlan(db, { name: 'p5b-subject-plan' });
  await replacePlanRules(db, subjectPlan.id, [
    { dimension: 'spend', period: 'total', cap: 1_000_000n },
  ]);

  const acct = req(
    (
      await db
        .insert(account)
        .values({
          tenantId: t.id,
          creditBalance: 100_000n,
          creditHeld: 50_000n,
          limitPlanId: tenantPlan.id,
        })
        .returning()
    )[0],
  );
  const key = req(
    (
      await db
        .insert(apiKey)
        .values({ tenantId: t.id, hash: 'h_p5b', limitPlanId: keyPlan.id })
        .returning()
    )[0],
  );
  const subj = req(
    (
      await db
        .insert(subject)
        .values({ tenantId: t.id, externalId: 'end-user-1', limitPlanId: subjectPlan.id })
        .returning()
    )[0],
  );

  return {
    tenantId: t.id,
    accountId: acct.id,
    apiKeyId: key.id,
    subjectId: subj.id,
    keyPlanId: keyPlan.id,
    tenantPlanId: tenantPlan.id,
    subjectPlanId: subjectPlan.id,
  };
}

/** A pending task row carrying the hold (the settle's transition target). */
async function pendingTask(s: Seed, holdAmount = 5_000n): Promise<string> {
  const { task } = await createTask(db, {
    tenantId: s.tenantId,
    apiKeyId: s.apiKeyId,
    subjectId: s.subjectId,
    operation: 'chat.completions',
    inputs: { model: 'test-model' },
    holdAmount,
    accountId: s.accountId,
  });
  return task.id;
}

const USAGE = {
  metrics: { input_tokens: 100, output_tokens: 50 },
  billingDims: {},
  estimated: false,
};

function settleInput(s: Seed, taskId: string | null): Parameters<typeof settleGatewayTask>[1] {
  return {
    taskId,
    tenantId: s.tenantId,
    accountId: s.accountId,
    subjectId: s.subjectId,
    holdAmount: 5_000n,
    finalCost: 1_500n,
    usage: USAGE,
    estimated: false,
    saleCardRef: { card_id: '00000000-0000-0000-0000-000000000001', version: 1 },
    costCardRef: null,
    usageLog: {
      model: 'test-model',
      apiKeyId: s.apiKeyId,
      providerCost: 700n,
      routeTag: 'canary',
    },
  };
}

describe('settleGatewayTask + usageLog envelope (P5b §9.1 层2)', () => {
  it('appends the usage_log row (cost/provider_cost/model/route_tag/key/subject) and accrues spend/tokens into EVERY bound scope', async () => {
    const s = await seed();
    const taskId = await pendingTask(s);

    const r = await settleGatewayTask(db, settleInput(s, taskId));
    expect(r.settled).toBe(true);
    expect(r.task?.status).toBe('succeeded');

    // usage_log mirror — the rolling-window + margin-analytics feed.
    const rows = await db.select().from(usageLog).where(eq(usageLog.tenantId, s.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 50,
      cost: 1_500n,
      providerCost: 700n,
      status: 'succeeded',
      apiKeyId: s.apiKeyId,
      subjectId: s.subjectId,
      routeTag: 'canary',
    });

    // limit_usage accrual — what the §7.8 precheckQuota getUsage reads next time.
    const day = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    await expect(
      getUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'spend',
        periodKey: day,
      }),
    ).resolves.toBe(1_500n); // spend 维 = finalCost (旧口径)
    await expect(
      getUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'tokens',
        periodKey: 'total',
      }),
    ).resolves.toBe(150n); // tokens 维 = input + output (旧口径)
    await expect(
      getUsage(db, {
        subjectType: 'tenant',
        subjectId: s.tenantId,
        dimension: 'spend',
        periodKey: month,
      }),
    ).resolves.toBe(1_500n);
    await expect(
      getUsage(db, {
        subjectType: 'subject',
        subjectId: s.subjectId,
        dimension: 'spend',
        periodKey: 'total',
      }),
    ).resolves.toBe(1_500n);

    // The tenant plan's 80%-of-2000 alert fired (1500 ≥ 1600? no — below).
    expect(await listLimitAlerts(db)).toHaveLength(0);
  });

  it('层2 闭环: two settles push the tenant spend bucket AT/OVER its cap — the precheck read (getUsage) now sees used ≥ cap and the threshold alert fired', async () => {
    const s = await seed();
    await settleGatewayTask(db, settleInput(s, await pendingTask(s)));
    await settleGatewayTask(db, settleInput(s, await pendingTask(s)));

    const month = new Date().toISOString().slice(0, 7);
    const used = await getUsage(db, {
      subjectType: 'tenant',
      subjectId: s.tenantId,
      dimension: 'spend',
      periodKey: month,
    });
    expect(used).toBe(3_000n);
    // precheckQuota's exact verdict expression (§9.1 layer 2): used >= cap → reject.
    expect(used >= 2_000n).toBe(true);

    // 80% of the 2000 cap crossed on the second accrual → idempotent alert row.
    const alerts = await listLimitAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      subjectType: 'tenant',
      subjectId: s.tenantId,
      dimension: 'spend',
      pct: 80,
    });
  });

  it('幂等: a replayed settle (transition no-op) neither double-charges NOR double-accrues NOR re-mirrors', async () => {
    const s = await seed();
    const taskId = await pendingTask(s);

    const first = await settleGatewayTask(db, settleInput(s, taskId));
    expect(first.settled).toBe(true);
    const replay = await settleGatewayTask(db, settleInput(s, taskId));
    expect(replay.settled).toBe(false); // already terminal — the guard

    const rows = await db.select().from(usageLog).where(eq(usageLog.tenantId, s.tenantId));
    expect(rows).toHaveLength(1); // ONE mirror row
    const day = new Date().toISOString().slice(0, 10);
    await expect(
      getUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'spend',
        periodKey: day,
      }),
    ).resolves.toBe(1_500n); // ONE accrual
  });

  it('rolling 窗口: windowedUsage(spend/tokens/requests) aggregates the new-face usage_log row', async () => {
    const s = await seed();
    await settleGatewayTask(db, settleInput(s, await pendingTask(s)));

    const since = new Date(Date.now() - 3_600_000);
    await expect(
      windowedUsage(db, { subjectType: 'key', subjectId: s.apiKeyId, dimension: 'spend', since }),
    ).resolves.toBe(1_500n);
    await expect(
      windowedUsage(db, { subjectType: 'key', subjectId: s.apiKeyId, dimension: 'tokens', since }),
    ).resolves.toBe(150n);
    await expect(
      windowedUsage(db, {
        subjectType: 'tenant',
        subjectId: s.tenantId,
        dimension: 'requests',
        since,
      }),
    ).resolves.toBe(1n);
    // Model-scoped rolling reads narrow on usage_log.model.
    await expect(
      windowedUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'spend',
        since,
        modelScope: 'other-model',
      }),
    ).resolves.toBe(0n);
  });

  it('row-less sync settle (taskId null) mirrors + accrues too — once per in-band call', async () => {
    const s = await seed();
    const r = await settleGatewayTask(db, settleInput(s, null));
    expect(r.settled).toBe(true);

    const rows = await db.select().from(usageLog).where(eq(usageLog.tenantId, s.tenantId));
    expect(rows).toHaveLength(1);
    const day = new Date().toISOString().slice(0, 10);
    await expect(
      getUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'spend',
        periodKey: day,
      }),
    ).resolves.toBe(1_500n);
  });

  it('no usageLog envelope → no usage row, no accrual (legacy-caller compat)', async () => {
    const s = await seed();
    const input = settleInput(s, await pendingTask(s));
    delete (input as { usageLog?: unknown }).usageLog;

    const r = await settleGatewayTask(db, input);
    expect(r.settled).toBe(true);
    expect(await db.select().from(usageLog).where(eq(usageLog.tenantId, s.tenantId))).toHaveLength(
      0,
    );
    const day = new Date().toISOString().slice(0, 10);
    await expect(
      getUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'spend',
        periodKey: day,
      }),
    ).resolves.toBe(0n);
  });

  it('providerCost null (对账降级) persists a NULL provider_cost; keyless settle leaves api_key_id NULL', async () => {
    const s = await seed();
    const input = settleInput(s, null);
    input.usageLog = { model: 'test-model', apiKeyId: null, providerCost: null };

    await settleGatewayTask(db, input);
    const row = req((await db.select().from(usageLog).where(eq(usageLog.tenantId, s.tenantId)))[0]);
    expect(row.providerCost).toBeNull();
    expect(row.apiKeyId).toBeNull();
    expect(row.routeTag).toBeNull();
    // No key attribution → key-plan buckets untouched; tenant/subject still accrue.
    const day = new Date().toISOString().slice(0, 10);
    await expect(
      getUsage(db, {
        subjectType: 'key',
        subjectId: s.apiKeyId,
        dimension: 'spend',
        periodKey: day,
      }),
    ).resolves.toBe(0n);
    const month = new Date().toISOString().slice(0, 7);
    await expect(
      getUsage(db, {
        subjectType: 'tenant',
        subjectId: s.tenantId,
        dimension: 'spend',
        periodKey: month,
      }),
    ).resolves.toBe(1_500n);
  });
});
