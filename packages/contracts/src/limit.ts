import { z } from 'zod';

/**
 * Governance & limits contracts (额度套餐). A `limit_plan` bundles `limit_rule`s
 * (one per `dimension × period` cap) and binds to API keys + tenants. Money caps
 * are integer µUSD; on the wire a rule's `cap` view is a decimal **string**
 * (bigint serialized), while a create/update rule sends `cap` as a base-unit
 * integer number (µUSD for `spend`, a count for the rest).
 */

export const LIMIT_DIMENSIONS = ['spend', 'requests', 'tokens', 'rpm', 'concurrency'] as const;
export const limitDimensionSchema = z.enum(LIMIT_DIMENSIONS);
export type LimitDimension = z.infer<typeof limitDimensionSchema>;

/** Accumulating periods (spend/requests/tokens). `rpm`→minute; `concurrency`→none. */
export const LIMIT_PERIODS = [
  'minute',
  'day',
  'month',
  'rolling_24h',
  'rolling_30d',
  'total',
] as const;
export const limitPeriodSchema = z.enum(LIMIT_PERIODS);

/** Periods valid for the accumulating dimensions (spend/requests/tokens). */
const ACCUM_PERIODS = ['day', 'month', 'rolling_24h', 'rolling_30d', 'total'] as const;

// ── views ────────────────────────────────────────────────────────────────────

export const limitRuleViewSchema = z.object({
  id: z.string(),
  dimension: limitDimensionSchema,
  /** day|month|rolling_24h|rolling_30d|total | minute (rpm) | null (concurrency). */
  period: z.string().nullable(),
  /** µUSD for spend, else a count/RPM/concurrency cap — decimal string (bigint). */
  cap: z.string(),
  model_scope: z.string().nullable(),
  alert_pct: z.number().nullable(),
  enforce: z.string(),
});
export type LimitRuleView = z.infer<typeof limitRuleViewSchema>;

export const limitPlanViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  rules: z.array(limitRuleViewSchema),
  /** Bound API keys (card stat). */
  key_count: z.number(),
  /** Bound tenants (card stat). */
  tenant_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LimitPlanView = z.infer<typeof limitPlanViewSchema>;

export const limitUsageViewSchema = z.object({
  subject_type: z.string(),
  subject_id: z.string(),
  dimension: z.string(),
  period_key: z.string(),
  model_scope: z.string(),
  used: z.string(),
  period_start: z.string().nullable(),
  updated_at: z.string(),
});
export type LimitUsageView = z.infer<typeof limitUsageViewSchema>;

export const limitAlertViewSchema = z.object({
  id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  rule_id: z.string(),
  dimension: z.string(),
  period_key: z.string(),
  used: z.string(),
  cap: z.string(),
  pct: z.number(),
  created_at: z.string(),
});
export type LimitAlertView = z.infer<typeof limitAlertViewSchema>;

// ── requests ──────────────────────────────────────────────────────────────────

/**
 * One rule in a create/update. `cap` is a base-unit integer (µUSD for `spend`,
 * else a count). The dimension↔period pairing is enforced by `superRefine`:
 * `rpm`→`minute`, `concurrency`→no period, others→an accumulating period.
 */
export const limitRuleInputSchema = z
  .object({
    dimension: limitDimensionSchema,
    period: limitPeriodSchema.nullable().optional(),
    cap: z.number().int().nonnegative(),
    modelScope: z.string().min(1).nullable().optional(),
    alertPct: z.number().int().min(1).max(100).nullable().optional(),
  })
  .superRefine((r, ctx) => {
    const p = r.period ?? null;
    if (r.dimension === 'rpm') {
      if (p !== 'minute')
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rpm rule period must be "minute"',
          path: ['period'],
        });
    } else if (r.dimension === 'concurrency') {
      if (p !== null)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'concurrency rule must have no period',
          path: ['period'],
        });
    } else if (p === null || !ACCUM_PERIODS.includes(p as (typeof ACCUM_PERIODS)[number])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${r.dimension} rule period must be one of ${ACCUM_PERIODS.join(', ')}`,
        path: ['period'],
      });
    }
  });
export type LimitRuleInput = z.infer<typeof limitRuleInputSchema>;

export const createLimitPlanRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  rules: z.array(limitRuleInputSchema).default([]),
});
export type CreateLimitPlanRequest = z.infer<typeof createLimitPlanRequestSchema>;

export const updateLimitPlanRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  /** When present, REPLACES the whole rule set. */
  rules: z.array(limitRuleInputSchema).optional(),
});
export type UpdateLimitPlanRequest = z.infer<typeof updateLimitPlanRequestSchema>;

/** Bind/unbind a plan to a key or tenant (`null` clears). */
export const setLimitPlanRequestSchema = z.object({
  planId: z.string().uuid().nullable(),
});
export type SetLimitPlanRequest = z.infer<typeof setLimitPlanRequestSchema>;
