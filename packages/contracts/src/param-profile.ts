// packages/contracts/src/param-profile.ts
//
// Model-param-binding contracts. Phase 0 added the per-(model×channel) OVERRIDE
// (`paramOpSchema`/`paramOverrideSchema`); Phase 1 adds the model-level
// `ModelParamProfile` (features + parameterRules + dropPolicy) frozen onto
// `model.param_profile`, plus the `resolveRule` template-merge helper.
import { z } from 'zod';

import { PARAM_TEMPLATES, type ParamTemplateName } from './param-templates.js';

/** Parameter value domains a rule declares (Dify `type`). `json` = arbitrary JSON value (stop arrays, schemas). */
export const PARAMETER_TYPES = ['float', 'int', 'boolean', 'string', 'enum', 'json'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/**
 * One declarative parameter rule (Dify `parameter_rules` shape). `name` is the
 * IR/OpenAI param name (`temperature`, `top_p`, `response_format`, `reasoning_effort`)
 * OR a model-specific declared param that otherwise rides the typed `extra`
 * passthrough (`enable_thinking`, `prompt_cache_key`, …). `useTemplate` inherits a
 * `PARAM_TEMPLATES` row; the remaining fields OVERRIDE the template when set
 * (precedence resolved by `resolveRule`). Per D2 there is NO `wirePath` in Phase 1 —
 * the adapter dialect remains authoritative for wire mapping; the profile only
 * allows/defaults/clamps/gates/drops.
 */
export const parameterRuleSchema = z.object({
  name: z.string().min(1),
  /** Inherit a shared template; must be a known `PARAM_TEMPLATES` key. */
  useTemplate: z.string().min(1).optional(),
  type: z.enum(PARAMETER_TYPES).optional(),
  /** Applied when the caller omits the param (post-template resolution). */
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
  /** enum options (e.g. reasoning_effort: low|medium|high). */
  options: z.array(z.string()).optional(),
  help: z.string().optional(),
});
export type ParameterRule = z.infer<typeof parameterRuleSchema>;

/**
 * Fine-grained capability features (upgrades the coarse `capabilities` booleans;
 * Dify `features`). Kept as a permissive `z.string()` array WITH a canonical
 * enum export for the UI/gate — an unknown feature string never blocks ingest
 * (back-compat with the `passthrough` philosophy).
 */
export const MODEL_FEATURES = [
  'tool-call',
  'parallel-tool-call',
  'vision',
  'audio',
  'file',
  'json-object',
  'json-schema',
  'reasoning',
  'stream',
] as const;
export type ModelFeature = (typeof MODEL_FEATURES)[number];

/** Policy for a KNOWN-STANDARD param the profile did NOT declare in `parameterRules`. */
export const DROP_POLICIES = ['error', 'drop', 'passthrough'] as const;
export type DropPolicy = (typeof DROP_POLICIES)[number];

/**
 * The model-level parameter profile (frozen onto `model.param_profile` jsonb per D1,
 * synced FROM `model_spec`). Empty profile == today's behavior (the regression
 * invariant): no features declared → gate passes everything; no rules → no
 * defaults/clamps; `dropPolicy` defaults to `passthrough` so non-declared params
 * forward unchanged (LiteLLM drop-and-forward semantics, D3).
 */
export const modelParamProfileSchema = z.object({
  features: z.array(z.string()).default([]),
  parameterRules: z.array(parameterRuleSchema).default([]),
  dropPolicy: z.enum(DROP_POLICIES).default('passthrough'),
});
export type ModelParamProfile = z.infer<typeof modelParamProfileSchema>;

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

// --- helpers (pure; safe to import from engine) ---------------------------

/**
 * Merge a rule with its `useTemplate` base: start from the template row (if any &
 * known), then overlay every field the rule itself sets (rule wins). Returns a
 * fully-resolved rule carrying `name`. A `useTemplate` naming an unknown template
 * is ignored (rule used as-is) — never throws, matching the passthrough philosophy.
 */
export function resolveRule(rule: ParameterRule): ParameterRule {
  const tplName = rule.useTemplate as ParamTemplateName | undefined;
  const tpl =
    tplName !== undefined && tplName in PARAM_TEMPLATES ? PARAM_TEMPLATES[tplName] : undefined;
  if (tpl === undefined) return rule;
  const merged: ParameterRule = { name: rule.name, ...(tpl as Partial<ParameterRule>) };
  // Overlay only the fields the rule explicitly set (undefined = inherit template).
  for (const k of ['type', 'default', 'min', 'max', 'required', 'options', 'help'] as const) {
    if (rule[k] !== undefined) (merged as Record<string, unknown>)[k] = rule[k];
  }
  return merged;
}

/**
 * The known-standard OpenAI-dialect WIRE (snake_case) sampling/penalty keys that
 * `dropUnsupported` (stage ④) may prune. A NON-standard `extra` key (top_k,
 * logit_bias, prompt_cache_key, service_tier, enable_thinking, …) is NEVER in
 * this set, so passthrough for non-standard params is guaranteed — the LiteLLM
 * drop-and-forward semantic. Kept in contracts (pure) so both the engine pipeline
 * and the OpenAI adapter can share it without a cross-package cycle.
 */
export const KNOWN_STANDARD_WIRE_PARAMS: readonly string[] = [
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'seed',
  'response_format',
  'reasoning_effort',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'n',
];

/**
 * The result of a stage-④ drop pass: the (possibly same-reference) body plus the
 * names of any known-standard keys that were pruned / would be rejected.
 */
export interface DropUnsupportedResult {
  body: Record<string, unknown>;
  dropped: string[];
}

/**
 * Stage ④ (pure, non-throwing): prune from an ALREADY-BUILT wire `body` any
 * known-standard sampling key the profile does NOT declare in `parameterRules`,
 * according to `dropPolicy`:
 *   - `passthrough` (default) — no-op; returns the SAME body reference (byte-for-byte
 *     identical to today). This is the regression invariant.
 *   - `drop` / `error` — remove every {@link KNOWN_STANDARD_WIRE_PARAMS} key that is
 *     present on the body but NOT named (post-`resolveRule`) by any rule. The
 *     `dropped` list lets the engine turn an `error`-policy prune into a 400
 *     (the adapter itself never throws — it stays a pure body transform).
 * NON-standard `extra` keys are never touched (they are not in the known set).
 */
export function dropUnsupportedBody(
  body: Record<string, unknown>,
  profile: ModelParamProfile | undefined,
): DropUnsupportedResult {
  if (profile === undefined || profile.dropPolicy === 'passthrough') {
    return { body, dropped: [] };
  }
  // The profile-ALLOWED wire names: each declared rule's resolved name mapped to
  // its OpenAI wire key (only meaningful for known-standard params).
  const allowed = new Set<string>();
  for (const rule of profile.parameterRules) {
    const name = resolveRule(rule).name;
    const wire = IR_NAME_TO_WIRE[name] ?? name;
    allowed.add(wire);
    allowed.add(name);
  }
  const dropped: string[] = [];
  for (const key of KNOWN_STANDARD_WIRE_PARAMS) {
    if (key in body && !allowed.has(key)) dropped.push(key);
  }
  if (dropped.length === 0) return { body, dropped: [] };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (dropped.includes(k)) continue;
    out[k] = v;
  }
  return { body: out, dropped };
}

/**
 * Map an IR/rule param name (camelCase or the caller's chosen name) to its
 * OpenAI wire (snake_case) key, so a rule declared as `max_tokens` or
 * `maxOutputTokens` both allow the `max_tokens` wire key. Only the standard
 * sampling params need mapping; anything else is used verbatim.
 */
const IR_NAME_TO_WIRE: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  topP: 'top_p',
  top_p: 'top_p',
  maxOutputTokens: 'max_tokens',
  max_tokens: 'max_tokens',
  stop: 'stop',
  seed: 'seed',
  responseFormat: 'response_format',
  response_format: 'response_format',
  reasoningEffort: 'reasoning_effort',
  reasoning_effort: 'reasoning_effort',
};

/**
 * The pure request-side profile pass the engine runs BEFORE `adapter.buildChatBody`
 * (pipeline steps ①②③④, D2). Mutation-free: returns a NEW params/extra pair.
 *   applyProfileDefaults → clampToRules → gate(features) → applyChannelOverride → dropUnsupported
 * `params`/`extra` are the IR request fields (camelCase params, open `extra` bag).
 * `resolvedModel` is the upstream model id (for `when.modelMatches`). Returns the
 * transformed pair plus any dropped/errored param names (for RELAY_TRACE + 400s).
 * Signature only — implementation lives in `packages/engine` (not shipped to the
 * browser bundle).
 */
export interface ApplyProfileInput {
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
  profile: ModelParamProfile;
  override?: ParamOverride;
  resolvedModel: string;
}
export interface ApplyProfileResult {
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
  dropped: string[];
  /** Populated only when `dropPolicy: 'error'` rejected a param — engine turns this into a 400. */
  rejected: string[];
}
