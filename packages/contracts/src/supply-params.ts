// packages/contracts/src/supply-params.ts
//
// model-supply-greenfield 批次0 — the FROZEN parameter contract (design §4 +
// §4.1). Two halves, two owners:
//
//   1. CANONICAL contract — hangs on the MODEL only (§4). Declares each
//      canonical param's type/domain/default + the billing_relevant two-level
//      marker, and absorbs the io_schema duty (form/playground rendering
//      derives from it; the type system includes file/media).
//   2. OFFERING declarations — per (model×channel) offering (§2.5). Five kinds
//      (supports / domain / map / fixed / unsupported) in ONE declaration
//      table; operator forced-params (the old param_override set/clamp/delete)
//      are the `origin: 'operator'` variants of the same rows.
//
// Semantics OWNERSHIP is pinned by §4.1 and must not drift: canonical 归一 =
// dialect facade (layer 1); these declarations are EXECUTED BY THE PLANNER
// ONLY (layer 2, producing EffectiveParams); adapter aspect ① is pure wire
// structure and NEVER reads declarations (layer 3). Precedence: operator
// variant > upstream declaration > canonical default. The invariant "operator
// variant ⊆ upstream domain" is CONFIG-TIME (checked at offering enable /
// golden probe) — never a silent runtime fallback.
//
// FREEZE CONTRACT (批次0 只增不改): additive-only after landing.
import { z } from 'zod';

import { OPERATIONS } from './gateway-ir.js';

// --- canonical param contract (model side, §4 / §2.1) ------------------------

/**
 * Canonical param value types (§2.1 类型系统含 file/media — absorbing the
 * io_schema vocabulary: `file` covers generic document inputs, `media` covers
 * image/audio/video inputs whose kinds ride `mediaKinds`; a list-valued input
 * uses `multiple: true` instead of a separate `file_list` type).
 */
export const CANONICAL_PARAM_TYPES = [
  'float',
  'int',
  'boolean',
  'string',
  'enum',
  'json',
  'file',
  'media',
] as const;
export type CanonicalParamType = (typeof CANONICAL_PARAM_TYPES)[number];

export const MEDIA_KINDS = ['image', 'audio', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Input media constraints for a file/media param (§2.1 输入媒体约束:
 * 格式/尺寸/时长/大小). The file pipeline validates sniffed media probes
 * against these (§9.4 探测结果与模型输入约束联动校验/转码).
 */
export const mediaConstraintSchema = z.object({
  /** Accepted MIME types (whitelist); absent → any the platform whitelist allows. */
  mimeTypes: z.array(z.string().min(1)).optional(),
  maxSizeBytes: z.number().int().positive().optional(),
  maxDurationSeconds: z.number().positive().optional(),
  minWidth: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
});
export type MediaConstraint = z.infer<typeof mediaConstraintSchema>;

/**
 * ONE canonical parameter declaration on the model's contract (§4). `name` is
 * the canonical (snake_case wire) param name callers use across every dialect
 * facade. `billingRelevant: true` puts the param in the two-level 计价 class:
 * it becomes a price-card tier dimension, and §4 rule 2 forces it through
 * candidate filtering ON ITS RESOLVED VALUE (explicit or default) — the
 * margin-inversion killer. Form/playground rendering derives from
 * `label`/`help`/`widget` (io_schema duty absorbed, §2.1).
 */
export const canonicalParamSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(CANONICAL_PARAM_TYPES),
    /** §4 两级: true = 参与售价 tier 的计价参数 (billing_relevant). */
    billingRelevant: z.boolean().default(false),
    required: z.boolean().default(false),
    /** Canonical default — rides GatewayRequest.params with `isDefault: true` when the caller omits the param (§4.1 layer 1). */
    default: z.unknown().optional(),
    /** Discrete domain (enum values / billing tiers). */
    values: z.array(z.union([z.string(), z.number()])).optional(),
    /** Numeric range domain. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** For `type: 'media'` — which media kinds this param accepts. */
    mediaKinds: z.array(z.enum(MEDIA_KINDS)).optional(),
    /** For file/media params — input constraints (§2.1). */
    constraint: mediaConstraintSchema.optional(),
    /** Accepts a LIST of values (the io_schema `file_list` equivalence). */
    multiple: z.boolean().optional(),
    label: z.string().optional(),
    help: z.string().optional(),
    /** Form-rendering hint (io_schema `widget` duty). */
    widget: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'enum' && (p.values === undefined || p.values.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enum param requires non-empty values',
        path: ['values'],
      });
    }
    if (p.mediaKinds !== undefined && p.type !== 'media') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mediaKinds is only valid on type: media',
        path: ['mediaKinds'],
      });
    }
  });
export type CanonicalParam = z.infer<typeof canonicalParamSchema>;

// --- offering param declarations (§4 five kinds + operator variants) ---------

export const PARAM_DECL_KINDS = ['supports', 'domain', 'map', 'fixed', 'unsupported'] as const;
export type ParamDeclKind = (typeof PARAM_DECL_KINDS)[number];

/**
 * Who authored a declaration row (§4: 运营者强制改参由 map/fixed 的运营者变体
 * 承接, 语义并入同一张声明表). Planner precedence: `operator` > `upstream` >
 * canonical default — an operator may TIGHTEN, never widen, upstream ability
 * (the ⊆-domain invariant is validated at enable/golden-probe time).
 */
export const PARAM_DECL_ORIGINS = ['upstream', 'operator'] as const;
export type ParamDeclOrigin = (typeof PARAM_DECL_ORIGINS)[number];

/**
 * The five declaration kinds (§4). ABSENCE of any row for a param means
 * `supports` over the full canonical domain (缺省 = supports 全域 — declaration
 * cost is amortized by probing/discovery, not front-loaded).
 *
 * - `supports`: explicit full-domain passthrough (documentation value only).
 * - `domain`: NARROWS the canonical domain (subset values and/or tighter
 *   numeric bounds). A billing_relevant param filters candidates on domain
 *   membership of its RESOLVED value (§4 rule 2).
 * - `map`: value/name mapping + type translation into the upstream dialect —
 *   `upstreamName` renames, `values` maps canonical→upstream values,
 *   `scale`/`offset` translate numeric ranges. THIS is where value semantics
 *   live (§4.1 layer 2) — never in adapter aspect ①.
 * - `fixed`: the upstream pins this param; `value` HONESTLY declares the
 *   actual canonical-domain value served (visible to docs/estimation; §4
 *   rule 2 filters when a billing_relevant resolved value ≠ fixed value).
 * - `unsupported`: the offering cannot serve requests carrying this param
 *   explicitly (candidate filtered by §4 rule 1).
 */
export const paramDeclRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('supports') }),
  z.object({
    kind: z.literal('domain'),
    values: z.array(z.union([z.string(), z.number()])).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    kind: z.literal('map'),
    /** Upstream wire param name, when it differs from the canonical name. */
    upstreamName: z.string().min(1).optional(),
    /** Discrete value mapping: canonical value (as string key) → upstream value. */
    values: z.record(z.string(), z.unknown()).optional(),
    /** Linear numeric translation: upstream = canonical × scale + offset. */
    scale: z.number().optional(),
    offset: z.number().optional(),
  }),
  z.object({
    kind: z.literal('fixed'),
    /** The ACTUAL canonical-domain value the upstream serves (诚实声明). */
    value: z.unknown(),
    /** The upstream wire value/name when the pinned wire form differs (cost side of §4 rule 2 双向可见). */
    upstreamValue: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('unsupported') }),
]);
export type ParamDeclRule = z.infer<typeof paramDeclRuleSchema>;

/**
 * One row of the offering's declaration table (§2.5 参数声明). `operation`
 * scopes the row when the model exposes several operation surfaces; absent →
 * applies to all of them. At most one row per (operation, param, origin) is
 * meaningful — later batches enforce that at write time.
 */
export const offeringParamDeclSchema = z
  .object({
    param: z.string().min(1),
    operation: z.enum(OPERATIONS).optional(),
    origin: z.enum(PARAM_DECL_ORIGINS).default('upstream'),
    rule: paramDeclRuleSchema,
  })
  .superRefine((row, ctx) => {
    if (row.rule.kind === 'fixed' && row.rule.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fixed declaration requires value',
        path: ['rule', 'value'],
      });
    }
    if (
      row.rule.kind === 'map' &&
      row.rule.upstreamName === undefined &&
      row.rule.values === undefined &&
      row.rule.scale === undefined &&
      row.rule.offset === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'map declaration requires at least one of upstreamName/values/scale/offset',
        path: ['rule'],
      });
    }
    if (
      row.rule.kind === 'domain' &&
      row.rule.values === undefined &&
      row.rule.min === undefined &&
      row.rule.max === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'domain declaration requires at least one of values/min/max',
        path: ['rule'],
      });
    }
  });
export type OfferingParamDecl = z.infer<typeof offeringParamDeclSchema>;
