// packages/contracts/src/param-profile.ts
//
// Phase 0 (model-param-binding): the per-(model×channel) parameter OVERRIDE
// contract only. The model-level `ModelParamProfile` / `parameterRule` /
// template library land in Phase 1 — this file is deliberately scoped to the
// `channel_model.param_override` slice so Phase 0 stays minimal.
import { z } from 'zod';

/**
 * Per-(model×channel) override op (new-api `ParamOverride` JSON operation). Applied
 * to the IR params/extra BEFORE the adapter renders the wire body (engine
 * pipeline step ②). `set` forces a value; `clamp` bounds to min/max; `delete`
 * removes the param. `when.modelMatches` scopes the op (one channel, many
 * models). Deliberately NOT a Turing-complete DSL (design §10 non-goal) — only
 * these three ops exist, so a `move`/`copy`/etc. is rejected at parse time.
 */
export const PARAM_OPS = ['set', 'clamp', 'delete'] as const;
export type ParamOp = (typeof PARAM_OPS)[number];

export const paramOpSchema = z
  .object({
    op: z.enum(PARAM_OPS),
    /** Target param name; a dotted path addresses a nested `extra` field (e.g. `thinking.type`). */
    name: z.string().min(1),
    /** `set` value. */
    value: z.unknown().optional(),
    /** `clamp` bounds (at least one required for `clamp`). */
    min: z.number().optional(),
    max: z.number().optional(),
    /** Optional gate: apply only when the resolved upstream model id matches (substring/exact). */
    when: z.object({ modelMatches: z.string().min(1).optional() }).optional(),
  })
  .superRefine((op, ctx) => {
    if (op.op === 'set' && op.value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set requires value', path: ['value'] });
    }
    if (op.op === 'clamp' && op.min === undefined && op.max === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clamp requires min or max',
        path: ['min'],
      });
    }
  });
export type ParamOpDef = z.infer<typeof paramOpSchema>;

/**
 * The per-(model×channel) override bag stored on `channel_model.param_override`
 * (mig 0062). An empty `ops` array (or a null column) is the regression
 * invariant: byte-for-byte identical to today's wire body.
 */
export const paramOverrideSchema = z.object({
  ops: z.array(paramOpSchema).default([]),
});
export type ParamOverride = z.infer<typeof paramOverrideSchema>;
