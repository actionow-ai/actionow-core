import { z } from 'zod';

export const PRICE_METHODS = [
  'unit',
  'matrix',
  'fixed',
  'formula',
  'passthrough',
  'model_token',
  'credits',
] as const;
export type PriceMethod = (typeof PRICE_METHODS)[number];
export const PRICE_TIMINGS = ['pre', 'post'] as const;
export type PriceTiming = (typeof PRICE_TIMINGS)[number];

export const markupSchema = z.object({
  type: z.enum(['percent', 'flat']),
  value: z.number().int(),
});
export type Markup = z.infer<typeof markupSchema>;

export const unitSpecSchema = z.object({
  method: z.literal('unit'),
  dimensions: z.record(z.string(), z.object({ rate: z.number().int().nonnegative() })),
});
export type UnitSpec = z.infer<typeof unitSpecSchema>;

export const matrixSpecSchema = z.object({
  method: z.literal('matrix'),
  key: z.array(z.string()).min(1),
  table: z.record(z.string(), z.number().int().nonnegative()),
  multiplier: z.string().optional(),
  perItem: z.string().optional(),
});
export type MatrixSpec = z.infer<typeof matrixSpecSchema>;

export const fixedSpecSchema = z.object({
  method: z.literal('fixed'),
  amount: z.number().int().nonnegative(),
});
export type FixedSpec = z.infer<typeof fixedSpecSchema>;

export const formulaSpecSchema = z.object({
  method: z.literal('formula'),
  expr: z.string().min(1),
});
export type FormulaSpec = z.infer<typeof formulaSpecSchema>;

export const passthroughSpecSchema = z.object({
  method: z.literal('passthrough'),
  markup: markupSchema.optional(),
});
export type PassthroughSpec = z.infer<typeof passthroughSpecSchema>;

export const modelTokenSpecSchema = z.object({
  method: z.literal('model_token'),
  /** µUSD per 1M input tokens (frozen from the model's `input_price`). */
  inputPrice: z.number().int().nonnegative(),
  /** µUSD per 1M output tokens (frozen from the model's `output_price`). */
  outputPrice: z.number().int().nonnegative(),
  /**
   * OPTIONAL µUSD per 1M CACHED-input tokens (用拆分计费), frozen from the model's
   * `cached_input_price`. When present, `priceModelToken` bills the
   * `usage.cached_input_tokens` portion of input (captured by #70) at THIS rate
   * and the remainder at `inputPrice`; absent → ALL input bills at `inputPrice`
   * (byte-identical to the pre-breakdown math — the regression invariant).
   */
  cachedInputPrice: z.number().int().nonnegative().optional(),
  /**
   * The per-group customer-price ratio in integer BASIS POINTS (`10000 = 1.0×`;
   * Track 5, spec §"Pricing model"). The key's route group resolves this
   * pre-routing (`route_group.group_ratio_bps`; default group → 10000); it is
   * folded into the `model_token` base as `roundHalfUp(base × bps / 10000)`
   * BEFORE the entry markup + modifier stack (group_ratio is the operator tier
   * markup; markup/modifiers apply after). Omitted → 10000 (×1.0), so an
   * un-threaded entry prices identically to Track 1 (the regression invariant).
   */
  groupRatioBps: z.number().int().positive().optional(),
});
export type ModelTokenSpec = z.infer<typeof modelTokenSpecSchema>;

/**
 * Credit-billed cost (Vidu/Kling — the 富媒体 credit primitive). The provider
 * meters in opaque "credits"; this spec converts that to integer µUSD:
 *   `credits = baseCredits + Σ dimensions[d].credits×v[d] + Σ addOns(flag truthy)`
 *   `cost   = credits × creditValueMicroUsd`.
 * The usage/param vector `v` is read in the SAME snake_case shape as `unit`
 * (missing dimension = 0, missing flag = false), so it serves both `quote`/hold
 * (request params) and `settle` (observed usage). All-integer bigint math.
 */
export const creditsSpecSchema = z.object({
  method: z.literal('credits'),
  /** µUSD per 1 credit (the credit→money conversion). */
  creditValueMicroUsd: z.number().int().nonnegative(),
  /** Flat credits charged per request regardless of usage. Default 0. */
  baseCredits: z.number().int().nonnegative().default(0),
  /** Credits per unit of each usage/param dimension (mirrors `unit`, but in CREDITS). */
  dimensions: z
    .record(z.string(), z.object({ credits: z.number().int().nonnegative() }))
    .default({}),
  /** Conditional credit add-ons: +credits when the named param/usage flag is truthy (e.g. audio, fast-mode). */
  addOns: z
    .array(z.object({ flag: z.string(), credits: z.number().int().nonnegative() }))
    .optional(),
});
export type CreditsSpec = z.infer<typeof creditsSpecSchema>;

export const priceSpecSchema = z.discriminatedUnion('method', [
  unitSpecSchema,
  matrixSpecSchema,
  fixedSpecSchema,
  formulaSpecSchema,
  passthroughSpecSchema,
  modelTokenSpecSchema,
  creditsSpecSchema,
]);
export type PriceSpec = z.infer<typeof priceSpecSchema>;

export const pricebookEntrySchema = z
  .object({
    resourceId: z.string(),
    resourceVersion: z.number().int(),
    version: z.number().int(),
    method: z.enum(PRICE_METHODS),
    timing: z.enum(PRICE_TIMINGS),
    spec: priceSpecSchema,
    markup: markupSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.method !== e.spec.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'method must equal spec.method',
        path: ['spec', 'method'],
      });
    }
  });
export type PricebookEntry = z.infer<typeof pricebookEntrySchema>;
