import { gte, sql } from 'drizzle-orm';

import { usageLog } from '../schema/index.js';
import type { DbOrTx } from './types.js';

/**
 * Per-model health derived from REAL traffic in `usage_log` over a window (no
 * synthetic probing → zero extra upstream cost). Availability = succeeded/total;
 * a model with no traffic in the window is simply absent (the status page shows
 * it as "no data"). Latency aggregates skip null `latency_ms`.
 */
export interface ModelHealthRow {
  readonly model: string;
  readonly total: number;
  readonly errors: number;
  /** avg(latency_ms), ms, rounded; null when no measured latency in the window. */
  readonly avgLatencyMs: number | null;
  /** p95(latency_ms), ms, rounded; null when no measured latency in the window. */
  readonly p95LatencyMs: number | null;
  /** Status of the MOST RECENT call (succeeded | failed | canceled). */
  readonly lastStatus: string | null;
  /** Timestamp of the most recent call for this model. */
  readonly lastSeenAt: Date | null;
}

interface RawHealthRow {
  model: string;
  total: string | number;
  errors: string | number;
  avgLatencyMs: string | number | null;
  p95LatencyMs: string | number | null;
  lastStatus: string | null;
  lastSeenAt: Date | string | null;
}

const num = (v: string | number | null): number | null =>
  v === null ? null : Math.round(Number(v));

/** Per-model health summary over `[since, now)`, ordered by traffic (busiest first). */
export async function listModelHealth(db: DbOrTx, since: Date): Promise<ModelHealthRow[]> {
  const rows = (await db
    .select({
      model: usageLog.model,
      total: sql<string>`count(*)`,
      errors: sql<string>`count(*) filter (where ${usageLog.status} <> 'succeeded')`,
      avgLatencyMs: sql<string | null>`avg(${usageLog.latencyMs})`,
      p95LatencyMs: sql<
        string | null
      >`percentile_cont(0.95) within group (order by ${usageLog.latencyMs})`,
      lastStatus: sql<
        string | null
      >`(array_agg(${usageLog.status} order by ${usageLog.createdAt} desc))[1]`,
      lastSeenAt: sql<Date | null>`max(${usageLog.createdAt})`,
    })
    .from(usageLog)
    .where(gte(usageLog.createdAt, since))
    .groupBy(usageLog.model)
    .orderBy(sql`count(*) desc`)) as RawHealthRow[];

  return rows.map((r) => ({
    model: r.model,
    total: Number(r.total),
    errors: Number(r.errors),
    avgLatencyMs: num(r.avgLatencyMs),
    p95LatencyMs: num(r.p95LatencyMs),
    lastStatus: r.lastStatus,
    lastSeenAt: r.lastSeenAt === null ? null : new Date(r.lastSeenAt),
  }));
}

/** One per-(model, day) bucket for the uptime sparkline. */
export interface ModelHealthBucket {
  readonly model: string;
  /** `YYYY-MM-DD` (UTC day). */
  readonly day: string;
  readonly total: number;
  readonly errors: number;
}

/** Per-model DAILY buckets over `[since, now)` for the status-page uptime bars. */
export async function listModelHealthHistory(
  db: DbOrTx,
  since: Date,
): Promise<ModelHealthBucket[]> {
  const day = sql<string>`to_char(date_trunc('day', ${usageLog.createdAt}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      model: usageLog.model,
      day,
      total: sql<string>`count(*)`,
      errors: sql<string>`count(*) filter (where ${usageLog.status} <> 'succeeded')`,
    })
    .from(usageLog)
    .where(gte(usageLog.createdAt, since))
    .groupBy(usageLog.model, day)
    .orderBy(usageLog.model, day);
  return rows.map((r) => ({
    model: r.model,
    day: r.day,
    total: Number(r.total),
    errors: Number(r.errors),
  }));
}
