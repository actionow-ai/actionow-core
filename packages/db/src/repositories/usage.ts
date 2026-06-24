import type { InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import { usageLog } from '../schema/index.js';
import { accrueLimitUsage } from './limit.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type UsageLogRow = InferSelectModel<typeof usageLog>;

/** Fields a caller supplies to {@link insertUsageLog}. */
export interface InsertUsageLogInput {
  readonly tenantId: string;
  readonly model: string;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  /** Final µcredit charge (mirrors the settle cost). Defaults to 0. */
  readonly cost?: bigint | undefined;
  /**
   * The served channel's ACTUAL cost for the call in µUSD (Track 5); omit/undefined
   * → null (unknown cost). `margin = cost − provider_cost`.
   */
  readonly providerCost?: bigint | undefined;
  readonly latencyMs?: number | null | undefined;
  /** `succeeded` | `failed` | `canceled`. */
  readonly status: string;
  /** The upstream_channel id that served this request (P1b); omit or pass undefined for unknown. */
  readonly channelId?: string | undefined;
  /** That channel's provider/adapter type (P1b); omit or pass undefined for unknown. */
  readonly providerType?: string | undefined;
  /** The api_key that made this call (P1c); omit or pass undefined when no key. */
  readonly apiKeyId?: string | undefined;
}

/** Insert one per-call `usage_log` row and return it. */
export async function insertUsageLog(db: DbOrTx, input: InsertUsageLogInput): Promise<UsageLogRow> {
  const rows = await db
    .insert(usageLog)
    .values({
      tenantId: input.tenantId,
      model: input.model,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      providerCost: input.providerCost ?? null,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      status: input.status,
      channelId: input.channelId ?? null,
      providerType: input.providerType ?? null,
      apiKeyId: input.apiKeyId ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertUsageLog: insert returned no row');
  // Accrue this billed call into the governance limit counters (spend/tokens) +
  // fire threshold alerts. No-op when neither the key nor tenant has a plan.
  await accrueLimitUsage(db, {
    tenantId: row.tenantId,
    apiKeyId: row.apiKeyId,
    model: row.model,
    cost: row.cost,
    tokens: BigInt((input.inputTokens ?? 0) + (input.outputTokens ?? 0)),
  });
  return row;
}

/** List one tenant's call logs, keyset-paginated newest-first on `(created_at, id)`. */
export async function listUsageLogsByTenant(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
): Promise<KeysetResult<UsageLogRow>> {
  return keysetPage<UsageLogRow>(db, {
    table: usageLog,
    createdAtCol: usageLog.createdAt,
    idCol: usageLog.id,
    where: eq(usageLog.tenantId, tenantId),
    page,
  });
}

/** List every tenant's call logs (admin global view), keyset-paginated newest-first. */
export async function listUsageLogsGlobal(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<UsageLogRow>> {
  return keysetPage<UsageLogRow>(db, {
    table: usageLog,
    createdAtCol: usageLog.createdAt,
    idCol: usageLog.id,
    page,
  });
}

/** One aggregated `usage_log` bucket (model/day/tenant/channel/api_key). */
export interface UsageRollupRow {
  /** The group key — model name, tenant id, channel id, api_key id, or ISO day. */
  bucket: string;
  /** `count(*)` for the bucket. */
  requests: number;
  /** `sum(input_tokens)` — bigint, never float. */
  inputTokens: bigint;
  /** `sum(output_tokens)` — bigint, never float. */
  outputTokens: bigint;
  /** `sum(cost)` in µcredits — bigint, never float. */
  cost: bigint;
  /** `sum(provider_cost)` (the served channels' actual cost) in µUSD — bigint (Track 5). */
  providerCost: bigint;
  /** `sum(cost) − sum(provider_cost)` — the operator margin in µUSD, bigint (Track 5). */
  margin: bigint;
  /** `count(*)` where `status <> 'succeeded'`. */
  errors: number;
  /** `avg(latency_ms)` over non-null latencies in the bucket, rounded to ms; `null` when none. */
  avgLatencyMs: number | null;
  /** `percentile_cont(0.95)` of latency_ms over the bucket, rounded to ms; `null` when none. */
  p95LatencyMs: number | null;
}

/** Inputs to {@link rollupUsage}. */
export interface UsageRollupQuery {
  /** Dimension to GROUP BY. Time grains (`minute`/`hour`/`day`) drive trends incl. RPM. */
  groupBy: 'minute' | 'hour' | 'day' | 'model' | 'tenant' | 'channel' | 'api_key';
  /** Restrict to one tenant (omit for a global, cross-tenant rollup). */
  tenantId?: string | undefined;
  /** Inclusive lower bound on `created_at`. */
  from?: Date | undefined;
  /** Exclusive upper bound on `created_at`. */
  to?: Date | undefined;
}

/**
 * The driver shape for one aggregate row. Postgres returns `count`/`sum` as
 * `numeric` (a string in the driver); the `?? 0` guards belt-and-suspenders
 * against a null the `coalesce(…, 0)`/`count(*)` should already preclude.
 */
interface RawRollupRow {
  bucket: string;
  requests: string | number | null;
  inputTokens: string | number | null;
  outputTokens: string | number | null;
  cost: string | number | null;
  providerCost: string | number | null;
  errors: string | number | null;
  avgLatencyMs: string | number | null;
  p95LatencyMs: string | number | null;
}

/** The SQL expression that yields the `bucket` string for a given dimension. */
function bucketExpr(groupBy: UsageRollupQuery['groupBy']): SQL<string> {
  switch (groupBy) {
    case 'minute':
      return sql<string>`to_char(date_trunc('minute', ${usageLog.createdAt}), 'YYYY-MM-DD"T"HH24:MI')`;
    case 'hour':
      return sql<string>`to_char(date_trunc('hour', ${usageLog.createdAt}), 'YYYY-MM-DD"T"HH24:00')`;
    case 'day':
      return sql<string>`to_char(date_trunc('day', ${usageLog.createdAt}), 'YYYY-MM-DD')`;
    case 'model':
      return sql<string>`${usageLog.model}`;
    case 'tenant':
      return sql<string>`${usageLog.tenantId}::text`;
    case 'channel':
      return sql<string>`coalesce(${usageLog.channelId}::text, 'unknown')`;
    case 'api_key':
      return sql<string>`coalesce(${usageLog.apiKeyId}::text, 'unknown')`;
  }
}

/**
 * GROUP-BY aggregation over `usage_log` for the admin analytics endpoint.
 *
 * Token and cost sums are bigint µcredits: postgres `sum()` of a bigint column
 * returns `numeric` (a string in the driver), so we `coalesce(…, 0)` in SQL and
 * parse with `BigInt()` — never `Number()`, to avoid float precision loss.
 * Counts are small and parsed with `Number()`. Rows are ordered by `bucket`.
 */
export async function rollupUsage(db: DbOrTx, q: UsageRollupQuery): Promise<UsageRollupRow[]> {
  const bucket = bucketExpr(q.groupBy);

  const predicates: SQL[] = [];
  if (q.tenantId !== undefined) predicates.push(eq(usageLog.tenantId, q.tenantId));
  if (q.from !== undefined) predicates.push(gte(usageLog.createdAt, q.from));
  if (q.to !== undefined) predicates.push(lt(usageLog.createdAt, q.to));
  const where = predicates.length > 0 ? and(...predicates) : undefined;

  const rows = await db
    .select({
      bucket,
      requests: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageLog.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageLog.outputTokens}), 0)`,
      cost: sql<string>`coalesce(sum(${usageLog.cost}), 0)`,
      // A NULL provider_cost (unknown channel cost) contributes 0 to the sum.
      providerCost: sql<string>`coalesce(sum(${usageLog.providerCost}), 0)`,
      errors: sql<string>`count(*) filter (where ${usageLog.status} <> 'succeeded')`,
      // Latency aggregates ignore NULL latency_ms (avg/percentile_cont skip nulls);
      // an all-null bucket yields NULL → mapped to `null` below.
      avgLatencyMs: sql<string | null>`avg(${usageLog.latencyMs})`,
      p95LatencyMs: sql<
        string | null
      >`percentile_cont(0.95) within group (order by ${usageLog.latencyMs})`,
    })
    .from(usageLog)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(bucket);

  return (rows as RawRollupRow[]).map((r) => {
    const cost = BigInt(r.cost ?? 0);
    const providerCost = BigInt(r.providerCost ?? 0);
    return {
      bucket: r.bucket,
      requests: Number(r.requests ?? 0),
      inputTokens: BigInt(r.inputTokens ?? 0),
      outputTokens: BigInt(r.outputTokens ?? 0),
      cost,
      providerCost,
      // margin = sum(cost) − sum(provider_cost), computed in bigint (never float).
      margin: cost - providerCost,
      errors: Number(r.errors ?? 0),
      avgLatencyMs: r.avgLatencyMs == null ? null : Math.round(Number(r.avgLatencyMs)),
      p95LatencyMs: r.p95LatencyMs == null ? null : Math.round(Number(r.p95LatencyMs)),
    };
  });
}

/**
 * Count `usage_log` rows in a `created_at` window (optionally one tenant) — the
 * billable-throughput primitive behind RPM. Cheap `count(*)` over the
 * `(tenant_id, created_at)` / `created_at` index; returns a plain number.
 */
export async function countUsageLogs(
  db: DbOrTx,
  opts: { from?: Date | undefined; to?: Date | undefined; tenantId?: string | undefined },
): Promise<number> {
  const predicates: SQL[] = [];
  if (opts.tenantId !== undefined) predicates.push(eq(usageLog.tenantId, opts.tenantId));
  if (opts.from !== undefined) predicates.push(gte(usageLog.createdAt, opts.from));
  if (opts.to !== undefined) predicates.push(lt(usageLog.createdAt, opts.to));
  const where = predicates.length > 0 ? and(...predicates) : undefined;
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(usageLog)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}
