// packages/db/src/repositories/reconciliation.ts
//
// model-supply-greenfield 批次4 slice6 — the §9.2 RECONCILIATION aggregation
// (对账降级 · 产品裁决: 中转渠道月度 usage 报表人工核对; 官方渠道按日自动对账
// 的比对器在批次5, 消费同一聚合 + RECONCILIATION_DEVIATION_PCT 阈值).
//
// Data source: the GATEWAY settle ledger rows (ledger_txn.type = 'settle',
// resource_id = `supply_offering:<id>`). Each row's `modifiers_applied`
// envelope carries the §9.2 dual-side stamps written by settleGatewayResult:
//   - sale side  = -credits_delta (the hold-capped charge)
//   - cost side  = modifiers_applied->>'cost_side_credits' (the offering cost
//     card's INDEPENDENT computation; null = degraded 对账降级)
//   - estimated  = modifiers_applied->>'estimated'
// Aggregated per (UTC day, tenant, offering) and joined onto the supply chain
// (offering → channel → provider, offering → model) for the report face.
//
// Money discipline: sums are bigint µcredits — postgres numeric comes back as
// a string and is parsed with BigInt(), never Number() (the rollupUsage
// precedent).
import { and, eq, gte, inArray, like, lt, type SQL, sql } from 'drizzle-orm';

import { ledgerTxn } from '../schema/execution.js';
import { supplyChannel, supplyModel, supplyOffering, supplyProvider } from '../schema/supply.js';
import type { DbOrTx } from './types.js';

/** The ledger attribution prefix settleGatewayTask stamps (`supply_offering:<id>`). */
export const OFFERING_RESOURCE_PREFIX = 'supply_offering:';

/** One (UTC day, tenant, offering) reconciliation bucket. */
export interface ReconciliationAggregateRow {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  tenantId: string;
  offeringId: string;
  channelId: string | null;
  channelName: string | null;
  providerSlug: string | null;
  modelName: string | null;
  settleCount: number;
  estimatedCount: number;
  /** Settles whose cost side degraded to null (§9.2 对账降级) — review flag. */
  costMissingCount: number;
  /** Sale-side µcredits charged (Σ -credits_delta). */
  saleSideCredits: bigint;
  /** Cost-side µcredits (Σ cost_side_credits; degraded rows contribute 0). */
  costSideCredits: bigint;
}

export interface ReconciliationQuery {
  /** Inclusive window start. */
  from: Date;
  /** Exclusive window end. */
  to: Date;
  /** Optional tenant scope. */
  tenantId?: string | undefined;
}

interface RawRow {
  day: string;
  tenantId: string;
  offeringId: string;
  channelId: string | null;
  channelName: string | null;
  providerSlug: string | null;
  modelName: string | null;
  settleCount: string | number;
  estimatedCount: string | number;
  costMissingCount: string | number;
  saleSideCredits: string | number | null;
  costSideCredits: string | number | null;
}

/**
 * Aggregate gateway settles for the §9.2 usage-side report. Rows are ordered
 * (day, tenant, offering) for a stable report; the supply joins are LEFT joins
 * — a hard-deleted/unknown offering id still reports its money (the ledger is
 * the source of truth, the catalog is decoration).
 */
export async function aggregateGatewayReconciliation(
  db: DbOrTx,
  q: ReconciliationQuery,
): Promise<ReconciliationAggregateRow[]> {
  const day = sql<string>`to_char(date_trunc('day', ${ledgerTxn.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  // The start offset MUST be inlined (sql.raw): a BOUND parameter arrives as
  // TEXT and flips postgres `substring` into its regex form — `substring(x
  // from '17')` pattern-matches "17" instead of slicing at position 17.
  const offeringId = sql<string>`substring(${ledgerTxn.resourceId} from ${sql.raw(String(OFFERING_RESOURCE_PREFIX.length + 1))})`;
  const costSide = sql`(${ledgerTxn.modifiersApplied} ->> 'cost_side_credits')`;

  const predicates: SQL[] = [
    eq(ledgerTxn.type, 'settle'),
    like(ledgerTxn.resourceId, `${OFFERING_RESOURCE_PREFIX}%`),
    gte(ledgerTxn.createdAt, q.from),
    lt(ledgerTxn.createdAt, q.to),
  ];
  if (q.tenantId !== undefined) predicates.push(eq(ledgerTxn.tenantId, q.tenantId));

  const rows = await db
    .select({
      day,
      tenantId: sql<string>`${ledgerTxn.tenantId}::text`,
      offeringId,
      channelId: sql<string | null>`${supplyChannel.id}::text`,
      channelName: sql<string | null>`${supplyChannel.name}`,
      providerSlug: sql<string | null>`${supplyProvider.slug}`,
      modelName: sql<string | null>`${supplyModel.name}`,
      settleCount: sql<string>`count(*)`,
      estimatedCount: sql<string>`count(*) filter (where (${ledgerTxn.modifiersApplied} ->> 'estimated')::boolean is true)`,
      costMissingCount: sql<string>`count(*) filter (where ${costSide} is null)`,
      saleSideCredits: sql<string>`coalesce(sum(-${ledgerTxn.creditsDelta}), 0)`,
      costSideCredits: sql<string>`coalesce(sum((${costSide})::numeric), 0)`,
    })
    .from(ledgerTxn)
    // The attribution string carries the offering id — join it back onto the
    // supply chain. `::text` comparisons keep a malformed id from throwing a
    // uuid cast error (it simply fails to join and reports bare).
    .leftJoin(supplyOffering, sql`${supplyOffering.id}::text = ${offeringId}`)
    .leftJoin(supplyChannel, eq(supplyChannel.id, supplyOffering.channelId))
    .leftJoin(supplyProvider, eq(supplyProvider.id, supplyChannel.providerId))
    .leftJoin(supplyModel, eq(supplyModel.id, supplyOffering.modelId))
    .where(and(...predicates))
    .groupBy(
      sql`1, 2, 3, ${supplyChannel.id}, ${supplyChannel.name}, ${supplyProvider.slug}, ${supplyModel.name}`,
    )
    .orderBy(sql`1, 2, 3`);

  return (rows as RawRow[]).map((r) => ({
    day: r.day,
    tenantId: r.tenantId,
    offeringId: r.offeringId,
    channelId: r.channelId,
    channelName: r.channelName,
    providerSlug: r.providerSlug,
    modelName: r.modelName,
    settleCount: Number(r.settleCount),
    estimatedCount: Number(r.estimatedCount),
    costMissingCount: Number(r.costMissingCount),
    saleSideCredits: BigInt(r.saleSideCredits ?? 0),
    costSideCredits: BigInt(r.costSideCredits ?? 0),
  }));
}

// --- per-settle samples (批次5 官方渠道日对账比对器 feed) ---------------------------

/**
 * One gateway settle SAMPLE for the daily official-channel comparer: the
 * observed usage vector plus the §9.2 cost-side stamp of a single settle row.
 * The comparer re-prices `usageVector` against the OFFICIAL price catalog
 * (matchOfficialPrice/officialPriceToSpec) and compares the result against the
 * booked `costSideCredits`.
 */
export interface GatewaySettleSampleRow {
  offeringId: string;
  /** The settle's observed usage metrics (`ledger_txn.usage_vector`); null = none recorded. */
  usageVector: Record<string, number> | null;
  /** The §9.2 cost-side stamp (µcredits); null = degraded (对账降级 — no cost card / compute failure). */
  costSideCredits: bigint | null;
  /** §9.2 estimated 标志 from the settle envelope. */
  estimated: boolean;
}

export interface GatewaySettleSampleQuery {
  /** Inclusive window start. */
  from: Date;
  /** Exclusive window end. */
  to: Date;
  /** The offerings to sample (exact `supply_offering:<id>` attribution match). */
  offeringIds: string[];
}

interface RawSampleRow {
  offeringId: string;
  usageVector: unknown;
  costSideCredits: string | null;
  estimated: boolean | null;
}

/**
 * Fetch the individual gateway settle rows for `offeringIds` inside a window —
 * the 批次5 daily comparer's per-settle feed (it needs each settle's OWN usage
 * vector to re-price against the official catalog; the aggregate view cannot
 * carry a non-linear re-pricing). Exact `resource_id` equality (not LIKE) so
 * the ledger index applies. Money discipline: `cost_side_credits` is parsed
 * with `BigInt`, never `Number`.
 */
export async function listGatewaySettleSamples(
  db: DbOrTx,
  q: GatewaySettleSampleQuery,
): Promise<GatewaySettleSampleRow[]> {
  if (q.offeringIds.length === 0) return [];
  const resourceIds = q.offeringIds.map((id) => `${OFFERING_RESOURCE_PREFIX}${id}`);
  const rows = await db
    .select({
      offeringId: sql<string>`substring(${ledgerTxn.resourceId} from ${sql.raw(String(OFFERING_RESOURCE_PREFIX.length + 1))})`,
      usageVector: ledgerTxn.usageVector,
      costSideCredits: sql<string | null>`(${ledgerTxn.modifiersApplied} ->> 'cost_side_credits')`,
      estimated: sql<boolean | null>`(${ledgerTxn.modifiersApplied} ->> 'estimated')::boolean`,
    })
    .from(ledgerTxn)
    .where(
      and(
        eq(ledgerTxn.type, 'settle'),
        inArray(ledgerTxn.resourceId, resourceIds),
        gte(ledgerTxn.createdAt, q.from),
        lt(ledgerTxn.createdAt, q.to),
      ),
    );

  return (rows as RawSampleRow[]).map((r) => ({
    offeringId: r.offeringId,
    usageVector: normalizeUsageVector(r.usageVector),
    costSideCredits: r.costSideCredits === null ? null : BigInt(r.costSideCredits),
    estimated: r.estimated === true,
  }));
}

/** Defensive jsonb → numeric-vector coercion (non-object / non-numeric values are dropped). */
function normalizeUsageVector(raw: unknown): Record<string, number> | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
