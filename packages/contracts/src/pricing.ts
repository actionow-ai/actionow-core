import { z } from 'zod';

export const PRICE_METHODS = [
  'unit',
  'matrix',
  'fixed',
  'formula',
  'passthrough',
  'model_token',
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

export const priceSpecSchema = z.discriminatedUnion('method', [
  unitSpecSchema,
  matrixSpecSchema,
  fixedSpecSchema,
  formulaSpecSchema,
  passthroughSpecSchema,
  modelTokenSpecSchema,
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
