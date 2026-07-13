// packages/engine/src/gateway/reconcile-daily.ts
//
// model-supply-greenfield 批次5 slice4 — the §9.2 OFFICIAL-CHANNEL daily
// reconciliation comparer (对账降级 · 产品裁决: 官方渠道有账单口径按日自动
// 对账、偏差超阈值告警; 中转渠道保持月度报表人工核对 — the R4① 砍刀 already
// shipped the monthly report in 批次4; this is the incremental daily half).
//
// One UTC day at a time:
//
//   1. Consume the SAME aggregation the monthly report reads
//      (aggregateGatewayReconciliation — already day-grained), collapsed per
//      offering (the cost side is tenant-independent).
//   2. Classify each offering OFFICIAL vs RELAY: the offering's channel →
//      provider slug matched against the official price catalog on the
//      offering's `upstream_model_name` (matchOfficialPrice). A match = the
//      provider has a published billing baseline (官方账单口径); no match =
//      a reseller/relay channel — monthly-report scope, marked but NEVER
//      day-compared (the 砍刀 floor must not regress, 判据 2.6).
//   3. For official offerings, re-price每笔 settle's OWN usage vector against
//      the official spec (officialPriceToSpec → the engine's proven
//      computeFinalCost, zero modifiers — the raw provider baseline) and
//      compare Σexpected vs Σbooked cost_side_credits.
//   4. Deviation above the RECONCILIATION_DEVIATION_PCT threshold (动态配置,
//      SettingsResolver hot-read) → one structured alert per offering
//      (best-effort observability — never throws into the sweep).
//
// Money discipline: sums are bigint µcredits; only the final RATIO is widened
// to a JS number (precision on the percentage, not the money).
import type { PriceSpec } from '@actionow/contracts';
import type { DbOrTx } from '@actionow/db';
import {
  aggregateGatewayReconciliation,
  getSupplyOfferingById,
  listGatewaySettleSamples,
  matchOfficialPrice,
  officialPriceToSpec,
} from '@actionow/db';
import { DomainError } from '@actionow/domain';

import { computeFinalCost } from '../pricing.js';
import type { SettingsResolver } from '../settings-resolver.js';
import { priceCardEntry } from './settle-task.js';

// --- deps -----------------------------------------------------------------------

/** The db read surface (injectable; production omits → real @actionow/db repos). */
export interface ReconcileDailyRepo {
  aggregateGatewayReconciliation: typeof aggregateGatewayReconciliation;
  listGatewaySettleSamples: typeof listGatewaySettleSamples;
  getSupplyOfferingById: typeof getSupplyOfferingById;
  matchOfficialPrice: typeof matchOfficialPrice;
}

export interface ReconcileDailyDeps {
  db: DbOrTx;
  repo?: Partial<ReconcileDailyRepo> | undefined;
  /**
   * 动态配置 hot-read for RECONCILIATION_DEVIATION_PCT (admin override → env →
   * default 5). Absent (partial test wiring) → {@link DEFAULT_DEVIATION_PCT}.
   */
  settings?: Pick<SettingsResolver, 'get'> | undefined;
  /**
   * The structured alert channel (偏差超阈值告警). Best-effort observability —
   * the §7.5 降级告警 pattern (default `console.warn`); a failing alert sink
   * must never fail the sweep, so throws are swallowed per offering.
   */
  alert?: ((message: string, context?: Record<string, unknown>) => void) | undefined;
}

function repoOf(deps: ReconcileDailyDeps): ReconcileDailyRepo {
  return {
    aggregateGatewayReconciliation:
      deps.repo?.aggregateGatewayReconciliation ?? aggregateGatewayReconciliation,
    listGatewaySettleSamples: deps.repo?.listGatewaySettleSamples ?? listGatewaySettleSamples,
    getSupplyOfferingById: deps.repo?.getSupplyOfferingById ?? getSupplyOfferingById,
    matchOfficialPrice: deps.repo?.matchOfficialPrice ?? matchOfficialPrice,
  };
}

// --- shapes ---------------------------------------------------------------------

/** Fallback threshold when no settings resolver is wired (mirrors the registry default). */
export const DEFAULT_DEVIATION_PCT = 5;

/**
 * How an offering participates in the §9.2 对账降级 split:
 * - `official` — provider has an official billing baseline → day-compared.
 * - `relay`    — 中转渠道: monthly-report scope only (marked, never compared).
 * - `unknown`  — the supply chain could not be resolved (offering soft-deleted /
 *   provider missing) → marked for review, never compared, never alerted.
 */
export type ReconcileChannelScope = 'official' | 'relay' | 'unknown';

/** One offering's daily reconciliation row. */
export interface DailyReconcileOfferingRow {
  offeringId: string;
  providerSlug: string | null;
  modelName: string | null;
  channelName: string | null;
  scope: ReconcileChannelScope;
  /** All settles in the day bucket (across tenants). */
  settleCount: number;
  /** §9.2 estimated 标志 count (platform-estimated usage). */
  estimatedCount: number;
  /** Settles whose cost side degraded to null (对账降级 review flag). */
  costMissingCount: number;
  /** Sale-side µcredits charged (Σ across tenants). */
  saleCredits: bigint;
  /** Booked cost-side µcredits (Σ; degraded settles contribute 0). */
  costCredits: bigint;
  /** Settles that entered the official re-pricing (usage + cost side both present). */
  comparedSettleCount: number;
  /** Booked cost over the COMPARED settles only (the deviation basis). */
  comparedCostCredits: bigint;
  /** Official-baseline recomputation over the compared settles; null = not compared. */
  expectedCostCredits: bigint | null;
  /** |booked − expected| / expected × 100 over the compared settles; null = not compared. */
  deviationPct: number | null;
  /** True when the deviation crossed the threshold and the alert fired. */
  alerted: boolean;
  /** Human note for non-compared / partially-compared rows. */
  note?: string | undefined;
}

export interface DailyReconcileResult {
  /** The reconciled UTC day (`YYYY-MM-DD`). */
  date: string;
  /** The RECONCILIATION_DEVIATION_PCT threshold in effect. */
  thresholdPct: number;
  perOffering: DailyReconcileOfferingRow[];
  officialCount: number;
  relayCount: number;
  unknownCount: number;
  alertsCount: number;
}

export interface DailyReconcileQuery {
  /** The UTC day to reconcile, `YYYY-MM-DD`. */
  date: string;
  /** Explicit threshold override (admin what-if); absent → settings → default. */
  thresholdPct?: number | undefined;
}

// --- date handling ---------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → the [00:00Z, +24h) window. Rejects malformed / non-existent days. */
export function utcDayWindow(date: string): { from: Date; to: Date } {
  if (!DATE_RE.test(date)) {
    throw new DomainError('invalid_input', `date must be YYYY-MM-DD, got '${date}'`);
  }
  const from = new Date(`${date}T00:00:00.000Z`);
  // A calendar-invalid day (e.g. 2026-02-30) rolls over in Date parsing — the
  // round-trip check rejects it instead of silently reconciling March 2nd.
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== date) {
    throw new DomainError('invalid_input', `'${date}' is not a valid UTC calendar day`);
  }
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

// --- the comparer ------------------------------------------------------------------

interface OfferingBucket {
  offeringId: string;
  providerSlug: string | null;
  modelName: string | null;
  channelName: string | null;
  settleCount: number;
  estimatedCount: number;
  costMissingCount: number;
  saleCredits: bigint;
  costCredits: bigint;
}

/**
 * THE daily official-channel reconciliation comparer (§9.2). Read-only over the
 * ledger + supply catalog; produces the structured result and fires one alert
 * per official offering whose deviation exceeds the threshold. Never mutates —
 * the alert channel is the only side effect.
 */
export async function reconcileDaily(
  deps: ReconcileDailyDeps,
  q: DailyReconcileQuery,
): Promise<DailyReconcileResult> {
  const repo = repoOf(deps);
  const { from, to } = utcDayWindow(q.date);
  const thresholdPct =
    q.thresholdPct ??
    (await deps.settings?.get('RECONCILIATION_DEVIATION_PCT')) ??
    DEFAULT_DEVIATION_PCT;

  // 1. the day's aggregates (same feed as the monthly report), collapsed per
  //    offering — the cost side is tenant-independent.
  const aggregates = await repo.aggregateGatewayReconciliation(deps.db, { from, to });
  const buckets = new Map<string, OfferingBucket>();
  for (const row of aggregates) {
    const bucket = buckets.get(row.offeringId) ?? {
      offeringId: row.offeringId,
      providerSlug: row.providerSlug,
      modelName: row.modelName,
      channelName: row.channelName,
      settleCount: 0,
      estimatedCount: 0,
      costMissingCount: 0,
      saleCredits: 0n,
      costCredits: 0n,
    };
    bucket.settleCount += row.settleCount;
    bucket.estimatedCount += row.estimatedCount;
    bucket.costMissingCount += row.costMissingCount;
    bucket.saleCredits += row.saleSideCredits;
    bucket.costCredits += row.costSideCredits;
    buckets.set(row.offeringId, bucket);
  }

  // 2. classify official vs relay (官方 = provider slug + upstream model name
  //    match a live billable official price row).
  const rows: DailyReconcileOfferingRow[] = [];
  const officialSpecs = new Map<string, PriceSpec>();
  for (const bucket of buckets.values()) {
    const base: DailyReconcileOfferingRow = {
      ...bucket,
      scope: 'unknown',
      comparedSettleCount: 0,
      comparedCostCredits: 0n,
      expectedCostCredits: null,
      deviationPct: null,
      alerted: false,
    };
    const offering = await repo.getSupplyOfferingById(deps.db, bucket.offeringId);
    if (offering === undefined || bucket.providerSlug === null) {
      base.note =
        offering === undefined
          ? 'offering not resolvable (soft-deleted?) — scope unknown, not compared'
          : 'provider not resolvable — scope unknown, not compared';
      rows.push(base);
      continue;
    }
    const official = await repo.matchOfficialPrice(
      deps.db,
      bucket.providerSlug,
      offering.upstreamModelName,
    );
    if (official === undefined) {
      base.scope = 'relay';
      base.note = '中转渠道 — monthly-report scope (§9.2 对账降级), not day-compared';
      rows.push(base);
      continue;
    }
    base.scope = 'official';
    officialSpecs.set(bucket.offeringId, officialPriceToSpec(official));
    rows.push(base);
  }

  // 3. re-price每笔 official settle's usage against the official baseline.
  const officialIds = [...officialSpecs.keys()];
  const samplesByOffering = new Map<string, { usage: Record<string, number>; cost: bigint }[]>();
  const skippedByOffering = new Map<string, number>();
  if (officialIds.length > 0) {
    const samples = await repo.listGatewaySettleSamples(deps.db, {
      from,
      to,
      offeringIds: officialIds,
    });
    for (const s of samples) {
      // Comparable = usage observed AND the cost side booked. Degraded settles
      // (§9.2 cost_missing) already ride the review flag; folding them in here
      // would alert every degraded day at 100% and drown the real signal.
      if (
        s.usageVector === null ||
        Object.keys(s.usageVector).length === 0 ||
        s.costSideCredits === null
      ) {
        skippedByOffering.set(s.offeringId, (skippedByOffering.get(s.offeringId) ?? 0) + 1);
        continue;
      }
      const list = samplesByOffering.get(s.offeringId) ?? [];
      list.push({ usage: s.usageVector, cost: s.costSideCredits });
      samplesByOffering.set(s.offeringId, list);
    }
  }

  let alertsCount = 0;
  for (const row of rows) {
    if (row.scope !== 'official') continue;
    const spec = officialSpecs.get(row.offeringId);
    if (spec === undefined) continue; // unreachable by construction
    const comparable = samplesByOffering.get(row.offeringId) ?? [];
    let unpriceable = 0;
    let expected = 0n;
    let booked = 0n;
    let compared = 0;
    for (const sample of comparable) {
      try {
        // The usage vector doubles as the dims/inputs vector: token/credits
        // specs price identically through quote and settle over it, and a
        // spec needing request-only dims simply fails closed → unpriceable.
        const entry = priceCardEntry(
          { id: `official:${row.offeringId}`, version: 0, spec },
          sample.usage,
        );
        expected += computeFinalCost(entry, sample.usage, sample.usage, []).credits;
        booked += sample.cost;
        compared += 1;
      } catch {
        unpriceable += 1; // audit-only — one bad sample must not kill the day
      }
    }
    row.comparedSettleCount = compared;
    row.comparedCostCredits = booked;
    const skipped = (skippedByOffering.get(row.offeringId) ?? 0) + unpriceable;
    if (skipped > 0) {
      row.note = `${String(skipped)} settle(s) not comparable (missing usage / degraded cost / unpriceable spec)`;
    }
    if (compared === 0) {
      row.note = row.note ?? 'no comparable settles for this day';
      continue;
    }
    row.expectedCostCredits = expected;
    row.deviationPct = deviationPct(booked, expected);
    if (row.deviationPct > thresholdPct) {
      row.alerted = true;
      alertsCount += 1;
      try {
        (deps.alert ?? console.warn)(
          `§9.2 daily reconciliation deviation: offering ${row.offeringId} (${row.providerSlug ?? '?'}/${row.modelName ?? '?'}) ` +
            `deviates ${row.deviationPct.toFixed(2)}% (> ${String(thresholdPct)}%) on ${q.date}`,
          {
            kind: 'reconciliation.deviation',
            date: q.date,
            offeringId: row.offeringId,
            providerSlug: row.providerSlug,
            modelName: row.modelName,
            comparedSettleCount: row.comparedSettleCount,
            comparedCostCredits: booked.toString(),
            expectedCostCredits: expected.toString(),
            deviationPct: row.deviationPct,
            thresholdPct,
          },
        );
      } catch {
        // The alert sink is observability-only — it must never fail the sweep.
      }
    }
  }

  rows.sort((a, b) => (a.offeringId < b.offeringId ? -1 : a.offeringId > b.offeringId ? 1 : 0));
  return {
    date: q.date,
    thresholdPct,
    perOffering: rows,
    officialCount: rows.filter((r) => r.scope === 'official').length,
    relayCount: rows.filter((r) => r.scope === 'relay').length,
    unknownCount: rows.filter((r) => r.scope === 'unknown').length,
    alertsCount,
  };
}

/** |booked − expected| / expected × 100; the expected==0 corner alerts only when money was booked. */
function deviationPct(booked: bigint, expected: bigint): number {
  if (expected === 0n) return booked === 0n ? 0 : 100;
  const diff = booked > expected ? booked - expected : expected - booked;
  return (Number(diff) / Number(expected)) * 100;
}
