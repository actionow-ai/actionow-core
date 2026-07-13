// packages/contracts/src/golden-probe.ts
//
// model-supply-greenfield 批次5 slice1 — the GOLDEN PROBE + offering ENABLE
// gate views (design §10 发现与批建 / §2.5 lifecycle / R5 探测预算).
//
// NOT a frozen batch-0 file — these are ordinary evolving admin views (the
// model-test.ts successor for the NEW world). Two doors, two owners:
//
//   - conformance suite (mock upstream, batch 2) gates DIALECT admission;
//   - golden probe (REAL upstream, THIS contract) gates OFFERING admission —
//     an offering may only turn `enabled` after a passing probe (§10).
//
// snake_case fields per the supply-entity view convention (model-test.ts's
// camelCase is the OLD world's and stays untouched).
import { z } from 'zod';

import { OPERATIONS } from './gateway-ir.js';

/** One leg of the two-part probe (connectivity vs functional — the model-test 判据 carried over). */
export const goldenProbeCheckSchema = z.object({
  ok: z.boolean(),
  /** Human-readable outcome (operator-facing; safe to render verbatim — never carries secrets). */
  message: z.string(),
  /** The {@link GatewayErrorCode} (or probe-internal code) when `ok` is false. */
  code: z.string().optional(),
});
export type GoldenProbeCheck = z.infer<typeof goldenProbeCheckSchema>;

/**
 * The golden-probe verdict for ONE offering (§10 真上游小样探测). Two
 * independent legs, same semantics as the old model-test:
 *
 * - `connectivity` — did we REACH the upstream and AUTHENTICATE? (transport
 *   failure / `unauthorized` / first-contact timeout fail this leg)
 * - `functional` — did the offering PRODUCE valid output? (a non-empty chat
 *   completion / a generated asset). A reached-but-erroring upstream passes
 *   connectivity and fails functional.
 *
 * `functional.ok && connectivity.ok` is THE enable gate (§10: 通过才可 enable).
 */
export const goldenProbeResultSchema = z.object({
  offering_id: z.string(),
  /** The model operation the probe exercised (the model's primary operation surface). */
  operation: z.enum(OPERATIONS),
  connectivity: goldenProbeCheckSchema,
  functional: goldenProbeCheckSchema,
  /** A small successful-output sample for operator confirmation (text excerpt or asset URL). */
  sample: z.object({ text: z.string().optional(), url: z.string().optional() }).optional(),
  /** Total probe wall-clock in milliseconds. */
  elapsed_ms: z.number().int().nonnegative(),
});
export type GoldenProbeResult = z.infer<typeof goldenProbeResultSchema>;

/**
 * R5 探测预算闸 refusal reasons: probes hit a REAL upstream (real money), so
 * the daily platform budget and the per-offering minimum interval refuse a
 * probe BEFORE any upstream call — a refusal is a first-class outcome, not an
 * upstream failure.
 */
export const GOLDEN_PROBE_REJECTION_REASONS = ['budget_exceeded', 'min_interval'] as const;

export const goldenProbeRejectionSchema = z.object({
  reason: z.enum(GOLDEN_PROBE_REJECTION_REASONS),
  message: z.string(),
  /** When to retry (seconds): min-interval remainder or the next UTC budget day. */
  retry_after_seconds: z.number().int().nonnegative().optional(),
});
export type GoldenProbeRejection = z.infer<typeof goldenProbeRejectionSchema>;

/** `POST /admin/supply/offerings/:id/probe` — the probe ran (result) or the budget gate refused it (rejection). */
export const probeSupplyOfferingResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), result: goldenProbeResultSchema }),
  z.object({ status: z.literal('rejected'), rejection: goldenProbeRejectionSchema }),
]);
export type ProbeSupplyOfferingResponse = z.infer<typeof probeSupplyOfferingResponseSchema>;

/**
 * The enable gates (§10 + the batch-3 CONFIG-TIME INVARIANTS contract pinned
 * in engine/planner/effective-params.ts):
 *
 * - `needs_pricing`        — the offering's model must carry a SALE price card (§10 永不 0 价上架).
 * - `operator_subset`      — invariant ①: operator-origin declarations ⊆ the upstream
 *                            declaration (existence AND value range; 收紧不放宽).
 * - `default_in_domain`    — invariant ②: every canonical default falls inside the
 *                            offering's declared domain (else the default is sent
 *                            upstream out-of-domain → upstream 4xx).
 * - `billing_translation_tier` — invariant ③: billing-relevant map/fixed translations
 *                            stay WITHIN the sale-card price tier of the canonical
 *                            value (毛利倒挂防线).
 * - `golden_probe`         — the real-upstream probe passed (§10 通过才可 enable).
 */
export const ENABLE_GATES = [
  'needs_pricing',
  'operator_subset',
  'default_in_domain',
  'billing_translation_tier',
  'golden_probe',
] as const;
export type EnableGate = (typeof ENABLE_GATES)[number];

/** One structured gate violation: WHICH invariant + WHICH param (§4.1 拒绝要可解释). */
export const enableGateViolationSchema = z.object({
  gate: z.enum(ENABLE_GATES),
  /** The canonical param the violation concerns, when param-scoped. */
  param: z.string().optional(),
  /** The operation surface the violation was found on, when operation-scoped. */
  operation: z.enum(OPERATIONS).optional(),
  message: z.string(),
});
export type EnableGateViolation = z.infer<typeof enableGateViolationSchema>;

/**
 * `POST /admin/supply/offerings/:id/enable` — the controlled draft/probing →
 * enabled transition. `enabled: false` answers 200 WITH the structured
 * violations (the gate verdict IS the payload — the §4.7 error envelope cannot
 * carry per-param structure); `probe` is present whenever the golden probe was
 * reached (config gates fail BEFORE spending probe budget).
 */
export const enableSupplyOfferingResponseSchema = z.object({
  enabled: z.boolean(),
  /** The offering's CURRENT status after the attempt (enabled / probing / reverted). */
  offering_status: z.string(),
  violations: z.array(enableGateViolationSchema),
  probe: probeSupplyOfferingResponseSchema.optional(),
});
export type EnableSupplyOfferingResponse = z.infer<typeof enableSupplyOfferingResponseSchema>;
