// packages/contracts/src/reconciliation.ts
//
// model-supply-greenfield 批次4 slice6 — the §9.2 RECONCILIATION REPORT wire
// shapes (对账降级 · 产品裁决): the platform ships a usage-side report
// aggregated per (day, tenant, channel, offering) with BOTH billing sides —
// sale (charged µcredits) and cost (the offering cost card's independent
// computation stamped at settle) — so 中转渠道 monthly reconciliation is a
// single GET, and 官方渠道 daily auto-reconciliation (批次5, threshold key
// RECONCILIATION_DEVIATION_PCT) reads the same aggregates.
//
// Money discipline: response money is ALWAYS a µcredit string (bigint-safe),
// matching every other admin view.
import { z } from 'zod';

/**
 * One aggregated reconciliation row: a (UTC day, tenant, offering) bucket of
 * gateway settles. `cost_missing_count` counts settles whose cost side was
 * degraded (`cost_side_credits: null` — no cost card / compute failure, §9.2
 * 对账降级); their cost contributes 0 to `cost_side_credits`, so a non-zero
 * count flags the bucket for manual review.
 */
export const reconciliationRowSchema = z.object({
  /** UTC day bucket, `YYYY-MM-DD`. */
  day: z.string(),
  tenant_id: z.string(),
  /** The supply offering the settles rode (ledger attribution `supply_offering:<id>`). */
  offering_id: z.string(),
  channel_id: z.string().nullable(),
  channel_name: z.string().nullable(),
  provider: z.string().nullable(),
  /** The supply model's external name (sale-side product face). */
  model: z.string().nullable(),
  settle_count: z.number().int().nonnegative(),
  /** Settles whose usage was platform-ESTIMATED (§9.2 estimated 标志). */
  estimated_count: z.number().int().nonnegative(),
  /** Settles whose cost side degraded to null (对账降级) — review flag. */
  cost_missing_count: z.number().int().nonnegative(),
  /** Sale-side charge total (µcredits, hold-capped settles). */
  sale_side_credits: z.string(),
  /** Cost-side total (µcredits; degraded settles contribute 0). */
  cost_side_credits: z.string(),
  /** sale − cost (µcredits; exactness degraded when cost_missing_count > 0). */
  gross_margin_credits: z.string(),
});
export type ReconciliationRow = z.infer<typeof reconciliationRowSchema>;

/** The §9.2 usage-side reconciliation report (月度报表可出即达标, 判据 2.6). */
export const reconciliationReportSchema = z.object({
  /** Inclusive ISO start instant of the report window. */
  from: z.string(),
  /** Exclusive ISO end instant of the report window. */
  to: z.string(),
  rows: z.array(reconciliationRowSchema),
  totals: z.object({
    settle_count: z.number().int().nonnegative(),
    estimated_count: z.number().int().nonnegative(),
    cost_missing_count: z.number().int().nonnegative(),
    sale_side_credits: z.string(),
    cost_side_credits: z.string(),
    gross_margin_credits: z.string(),
  }),
});
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
