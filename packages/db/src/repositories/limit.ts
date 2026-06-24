import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  account,
  apiKey,
  limitAlert,
  limitPlan,
  limitRule,
  limitUsage,
  usageLog,
} from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type LimitPlanRow = InferSelectModel<typeof limitPlan>;
export type LimitRuleRow = InferSelectModel<typeof limitRule>;
export type LimitUsageRow = InferSelectModel<typeof limitUsage>;
export type LimitAlertRow = InferSelectModel<typeof limitAlert>;

// ── plans ──────────────────────────────────────────────────────────────────

/** Insert a limit plan (额度套餐). */
export async function createLimitPlan(
  db: DbOrTx,
  input: { name: string; description?: string | null; status?: string },
): Promise<LimitPlanRow> {
  const rows = await db
    .insert(limitPlan)
    .values({
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createLimitPlan: insert returned no row');
  return row;
}

/** List live plans (newest name order). */
export function listLimitPlans(db: DbOrTx): Promise<LimitPlanRow[]> {
  return db.select().from(limitPlan).where(isNull(limitPlan.deletedAt)).orderBy(limitPlan.name);
}

/** Fetch a live plan by id, or undefined. */
export async function getLimitPlanById(db: DbOrTx, id: string): Promise<LimitPlanRow | undefined> {
  const rows = await db
    .select()
    .from(limitPlan)
    .where(and(eq(limitPlan.id, id), isNull(limitPlan.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Mutable plan fields; omitted keys unchanged. */
export interface UpdateLimitPlanInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly status?: string | undefined;
}

/** Patch a live plan, returning the new row (undefined when absent/deleted). */
export async function updateLimitPlan(
  db: DbOrTx,
  id: string,
  patch: UpdateLimitPlanInput,
): Promise<LimitPlanRow | undefined> {
  const set: Partial<LimitPlanRow> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.status !== undefined) set.status = patch.status;
  if (Object.keys(set).length === 0) return getLimitPlanById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(limitPlan)
    .set(set)
    .where(and(eq(limitPlan.id, id), isNull(limitPlan.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete a plan (frees its name). Returns the id or undefined (idempotent). */
export async function softDeleteLimitPlan(db: DbOrTx, id: string): Promise<string | undefined> {
  const rows = await db
    .update(limitPlan)
    .set({ deletedAt: new Date() })
    .where(and(eq(limitPlan.id, id), isNull(limitPlan.deletedAt)))
    .returning({ id: limitPlan.id });
  return rows[0]?.id;
}

// ── rules ──────────────────────────────────────────────────────────────────

/** One rule to write under a plan (replace-all on plan edit). */
export interface LimitRuleInput {
  readonly dimension: string;
  readonly period?: string | null | undefined;
  readonly cap: bigint;
  readonly modelScope?: string | null | undefined;
  readonly alertPct?: number | null | undefined;
  readonly enforce?: string | undefined;
}

/** The rules of one plan. */
export function listRulesByPlan(db: DbOrTx, planId: string): Promise<LimitRuleRow[]> {
  return db.select().from(limitRule).where(eq(limitRule.planId, planId));
}

/** The rules of several plans, grouped by `plan_id` (resolver + list counts). */
export async function listRulesByPlanIds(
  db: DbOrTx,
  planIds: string[],
): Promise<Map<string, LimitRuleRow[]>> {
  const out = new Map<string, LimitRuleRow[]>();
  if (planIds.length === 0) return out;
  const rows = await db.select().from(limitRule).where(inArray(limitRule.planId, planIds));
  for (const r of rows) {
    const list = out.get(r.planId) ?? [];
    list.push(r);
    out.set(r.planId, list);
  }
  return out;
}

/**
 * Replace ALL rules of a plan in one transaction (the plan editor edits the
 * whole rule list). Alerts keep a denormalized `rule_id` (no FK) so old rules
 * can be deleted freely.
 */
export async function replacePlanRules(
  db: DbOrTx,
  planId: string,
  rules: readonly LimitRuleInput[],
): Promise<LimitRuleRow[]> {
  const run = async (tx: DbOrTx): Promise<LimitRuleRow[]> => {
    await tx.delete(limitRule).where(eq(limitRule.planId, planId));
    if (rules.length === 0) return [];
    return tx
      .insert(limitRule)
      .values(
        rules.map((r) => ({
          planId,
          dimension: r.dimension,
          period: r.period ?? null,
          cap: r.cap,
          modelScope: r.modelScope ?? null,
          alertPct: r.alertPct ?? null,
          ...(r.enforce !== undefined ? { enforce: r.enforce } : {}),
        })),
      )
      .returning();
  };
  // Reuse an open transaction, else open one (atomic delete+insert).
  return 'transaction' in db ? db.transaction((tx) => run(tx)) : run(db);
}

/**
 * The effective rules for a request: the rules of the (live, ACTIVE) key plan
 * UNION the (live, active) tenant plan. A disabled/deleted/absent plan
 * contributes nothing. AND-combined at enforcement time (governance-limits §1).
 */
export async function resolveEffectiveRules(
  db: DbOrTx,
  keyPlanId: string | null,
  tenantPlanId: string | null,
): Promise<LimitRuleRow[]> {
  const ids = [keyPlanId, tenantPlanId].filter((x): x is string => x !== null);
  if (ids.length === 0) return [];
  const activePlans = await db
    .select({ id: limitPlan.id })
    .from(limitPlan)
    .where(
      and(inArray(limitPlan.id, ids), eq(limitPlan.status, 'active'), isNull(limitPlan.deletedAt)),
    );
  const activeIds = activePlans.map((p) => p.id);
  if (activeIds.length === 0) return [];
  return db.select().from(limitRule).where(inArray(limitRule.planId, activeIds));
}

/**
 * The `period_key` bucket for a materialized period at `now` (UTC):
 * `day`→`YYYY-MM-DD`, `month`→`YYYY-MM`, `total`→`total`. Rolling/minute periods
 * are not materialized (the caller computes them via a windowed query / Redis).
 */
export function periodKeyFor(period: string, now: Date): string {
  const iso = now.toISOString();
  if (period === 'day') return iso.slice(0, 10);
  if (period === 'month') return iso.slice(0, 7);
  return 'total';
}

/** Period start instant for a materialized period at `now` (for `period_start`). */
export function periodStartFor(period: string, now: Date): Date {
  if (period === 'day') return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (period === 'month') return new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  return new Date(0);
}

// ── usage accumulator ────────────────────────────────────────────────────────

/** The 5-part key identifying one usage bucket. */
export interface UsageKey {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly dimension: string;
  readonly periodKey: string;
  readonly modelScope?: string;
}

/** Current accumulated usage for a bucket (0 when none). */
export async function getUsage(db: DbOrTx, key: UsageKey): Promise<bigint> {
  const rows = await db
    .select({ used: limitUsage.used })
    .from(limitUsage)
    .where(
      and(
        eq(limitUsage.subjectType, key.subjectType),
        eq(limitUsage.subjectId, key.subjectId),
        eq(limitUsage.dimension, key.dimension),
        eq(limitUsage.periodKey, key.periodKey),
        eq(limitUsage.modelScope, key.modelScope ?? ''),
      ),
    )
    .limit(1);
  return rows[0]?.used ?? 0n;
}

/** Atomically add `delta` to a usage bucket (UPSERT), returning the new total. */
export async function incrUsage(
  db: DbOrTx,
  key: UsageKey,
  delta: bigint,
  periodStart?: Date,
): Promise<bigint> {
  const rows = await db
    .insert(limitUsage)
    .values({
      subjectType: key.subjectType,
      subjectId: key.subjectId,
      dimension: key.dimension,
      periodKey: key.periodKey,
      modelScope: key.modelScope ?? '',
      used: delta,
      ...(periodStart !== undefined ? { periodStart } : {}),
    })
    .onConflictDoUpdate({
      target: [
        limitUsage.subjectType,
        limitUsage.subjectId,
        limitUsage.dimension,
        limitUsage.periodKey,
        limitUsage.modelScope,
      ],
      set: { used: sql`${limitUsage.used} + ${delta}`, updatedAt: new Date() },
    })
    .returning({ used: limitUsage.used });
  return rows[0]?.used ?? delta;
}

/**
 * Windowed usage over `usage_log` for a ROLLING period (not materialized): the
 * `spend` (Σcost µUSD), `requests` (count), or `tokens` (Σ input+output) for a
 * subject since `since`, optionally narrowed to a model. Used by the guard's
 * rolling_24h / rolling_30d rules.
 */
export async function windowedUsage(
  db: DbOrTx,
  opts: {
    subjectType: string;
    subjectId: string;
    dimension: string;
    since: Date;
    modelScope?: string | null;
  },
): Promise<bigint> {
  const subjectCol = opts.subjectType === 'key' ? usageLog.apiKeyId : usageLog.tenantId;
  const expr =
    opts.dimension === 'spend'
      ? sql<string>`coalesce(sum(${usageLog.cost}), 0)`
      : opts.dimension === 'tokens'
        ? sql<string>`coalesce(sum(${usageLog.inputTokens} + ${usageLog.outputTokens}), 0)`
        : sql<string>`count(*)`;
  const rows = await db
    .select({ v: expr })
    .from(usageLog)
    .where(
      and(
        eq(subjectCol, opts.subjectId),
        sql`${usageLog.createdAt} >= ${opts.since}`,
        opts.modelScope ? eq(usageLog.model, opts.modelScope) : undefined,
      ),
    );
  return BigInt(rows[0]?.v ?? '0');
}

/** All usage rows for a subject (the usage-vs-cap UI). */
export function listUsageForSubject(
  db: DbOrTx,
  subjectType: string,
  subjectId: string,
): Promise<LimitUsageRow[]> {
  return db
    .select()
    .from(limitUsage)
    .where(and(eq(limitUsage.subjectType, subjectType), eq(limitUsage.subjectId, subjectId)));
}

// ── alerts ────────────────────────────────────────────────────────────────

/** Record a threshold crossing; idempotent per (subject, rule, period, pct). */
export async function recordLimitAlert(
  db: DbOrTx,
  input: {
    subjectType: string;
    subjectId: string;
    ruleId: string;
    dimension: string;
    periodKey: string;
    used: bigint;
    cap: bigint;
    pct: number;
  },
): Promise<LimitAlertRow | undefined> {
  const rows = await db
    .insert(limitAlert)
    .values(input)
    .onConflictDoNothing({
      target: [
        limitAlert.subjectType,
        limitAlert.subjectId,
        limitAlert.ruleId,
        limitAlert.periodKey,
        limitAlert.pct,
      ],
    })
    .returning();
  return rows[0];
}

/** Recent alerts (newest first) for the operator alert list. */
export function listLimitAlerts(db: DbOrTx, limit = 100): Promise<LimitAlertRow[]> {
  return db
    .select()
    .from(limitAlert)
    .orderBy(sql`${limitAlert.createdAt} DESC`)
    .limit(limit);
}

// ── bindings ──────────────────────────────────────────────────────────────

/** Bind/unbind a limit plan to a LIVE api key. `true` when a row was updated. */
export async function setApiKeyLimitPlan(
  db: DbOrTx,
  apiKeyId: string,
  planId: string | null,
): Promise<boolean> {
  const rows = await db
    .update(apiKey)
    .set({ limitPlanId: planId, updatedAt: new Date() })
    .where(and(eq(apiKey.id, apiKeyId), isNull(apiKey.deletedAt)))
    .returning({ id: apiKey.id });
  return rows.length === 1;
}

/** Bind/unbind a tenant-level limit plan (on the tenant's `account`). */
export async function setTenantLimitPlan(
  db: DbOrTx,
  tenantId: string,
  planId: string | null,
): Promise<boolean> {
  const rows = await db
    .update(account)
    .set({ limitPlanId: planId })
    .where(and(eq(account.tenantId, tenantId), isNull(account.deletedAt)))
    .returning({ id: account.id });
  return rows.length === 1;
}

/** How many live keys + tenants each plan id is bound to (plan list card stats). */
export async function countPlanBindings(
  db: DbOrTx,
  planIds: string[],
): Promise<Map<string, { keys: number; tenants: number }>> {
  const out = new Map<string, { keys: number; tenants: number }>();
  if (planIds.length === 0) return out;
  for (const id of planIds) out.set(id, { keys: 0, tenants: 0 });
  const keyRows = await db
    .select({ pid: apiKey.limitPlanId, n: sql<number>`count(*)::int` })
    .from(apiKey)
    .where(and(inArray(apiKey.limitPlanId, planIds), isNull(apiKey.deletedAt)))
    .groupBy(apiKey.limitPlanId);
  for (const r of keyRows)
    if (r.pid !== null) out.set(r.pid, { keys: r.n, tenants: out.get(r.pid)?.tenants ?? 0 });
  const tenantRows = await db
    .select({ pid: account.limitPlanId, n: sql<number>`count(*)::int` })
    .from(account)
    .where(and(inArray(account.limitPlanId, planIds), isNull(account.deletedAt)))
    .groupBy(account.limitPlanId);
  for (const r of tenantRows)
    if (r.pid !== null) out.set(r.pid, { keys: out.get(r.pid)?.keys ?? 0, tenants: r.n });
  return out;
}
