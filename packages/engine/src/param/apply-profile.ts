// packages/engine/src/param/apply-profile.ts
//
// Engine pipeline stages ① (defaults + clamp) + ③ (gate) + ④ (dropUnsupported)
// for the model-level ModelParamProfile (Phase 1). PURE transforms over the IR
// `ChatRequest`; no DB, no NestJS.
//
// REGRESSION INVARIANT (the #1 requirement): an EMPTY profile
// (`features:[] parameterRules:[] dropPolicy:'passthrough'`) or `undefined`
// collapses every stage to a SAME-REFERENCE no-op, so the wire body and the
// settled cost are byte-for-byte / cent-for-cent identical to before Phase 1.
//
// Precedence (enforced by ordering at the call site):
//   request > ② channel override > ① profile default > dialect default.
// `applyProfileDefaults` only FILLS an absent value (request always wins);
// `clampToRules` bounds the resolved value into a rule's min/max.
import type {
  ChatParams,
  ChatRequest,
  ModelParamProfile,
  ParameterRule,
} from '@actionow/contracts';
import { dropUnsupportedBody, resolveRule } from '@actionow/contracts';
import { type ModelCapabilities, normalizeRequest } from '@actionow/llm-protocol';

import { engineError } from '../errors.js';

/**
 * Empty-profile sentinel: no features declared AND no parameter rules. Such a
 * profile gates nothing / defaults nothing / clamps nothing, so the pipeline is a
 * no-op. `dropPolicy` alone does not make a profile "non-empty" — with no rules
 * there is no allow-list to prune against, so `dropUnsupported` is still a no-op.
 */
export function isEmptyProfile(p: ModelParamProfile | undefined): boolean {
  return p === undefined || (p.features.length === 0 && p.parameterRules.length === 0);
}

/**
 * The standard IR `params` (camelCase) key each rule name (IR name OR its wire
 * snake_case alias) addresses, so a rule declared `max_tokens` / `maxOutputTokens`
 * both bind to `params.maxOutputTokens`. A rule whose name is not a standard
 * sampling param rides `extra` (model-specific declared param, D2).
 */
const RULE_NAME_TO_PARAM: Readonly<Record<string, keyof ChatParams>> = {
  temperature: 'temperature',
  top_p: 'topP',
  topP: 'topP',
  max_tokens: 'maxOutputTokens',
  maxOutputTokens: 'maxOutputTokens',
  max_output_tokens: 'maxOutputTokens',
  stop: 'stop',
  seed: 'seed',
  response_format: 'responseFormat',
  responseFormat: 'responseFormat',
  reasoning_effort: 'reasoningEffort',
  reasoningEffort: 'reasoningEffort',
};

/** Where a resolved rule targets in the IR: a first-class `params` key, or an `extra` key. */
function ruleTarget(
  rule: ParameterRule,
): { kind: 'param'; key: keyof ChatParams } | { kind: 'extra'; key: string } {
  const paramKey = RULE_NAME_TO_PARAM[rule.name];
  if (paramKey !== undefined) return { kind: 'param', key: paramKey };
  return { kind: 'extra', key: rule.name };
}

function clampNumber(v: number, min: number | undefined, max: number | undefined): number {
  let next = v;
  if (min !== undefined && next < min) next = min;
  if (max !== undefined && next > max) next = max;
  return next;
}

/**
 * Stage ① (defaults): for each declared rule that carries a `default` (after
 * template resolution), fill it ONLY when the request omits that param. The
 * request value always wins. Returns the SAME `req` reference when nothing was
 * filled (empty profile → no-op).
 */
export function applyProfileDefaults(req: ChatRequest, profile: ModelParamProfile): ChatRequest {
  if (profile.parameterRules.length === 0) return req;
  let params: Record<string, unknown> | undefined;
  let extra: Record<string, unknown> | undefined;
  const curParams = (req.params ?? {}) as Record<string, unknown>;
  const curExtra = req.extra ?? {};

  for (const raw of profile.parameterRules) {
    const rule = resolveRule(raw);
    if (rule.default === undefined) continue;
    const target = ruleTarget(rule);
    if (target.kind === 'param') {
      const seen = params ?? curParams;
      if (seen[target.key] === undefined) {
        params = { ...(params ?? curParams) };
        params[target.key] = rule.default;
      }
    } else {
      const seen = extra ?? curExtra;
      if (seen[target.key] === undefined) {
        extra = { ...(extra ?? curExtra) };
        extra[target.key] = rule.default;
      }
    }
  }
  if (params === undefined && extra === undefined) return req;
  return {
    ...req,
    ...(params !== undefined ? { params: params } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}

/**
 * Stage ① (clamp): for each declared rule with a numeric min/max, bound the
 * request's value into range. An out-of-range value under `dropPolicy:'error'`
 * throws (400 `invalid_input`); otherwise it is clamped silently (both `drop` and
 * the default `passthrough` clamp — clamping is safer than forwarding an illegal
 * value, and never over-drops). Returns the SAME `req` reference when nothing
 * changed.
 */
export function clampToRules(req: ChatRequest, profile: ModelParamProfile): ChatRequest {
  if (profile.parameterRules.length === 0) return req;
  let params: Record<string, unknown> | undefined;
  let extra: Record<string, unknown> | undefined;
  const curParams = (req.params ?? {}) as Record<string, unknown>;
  const curExtra = req.extra ?? {};

  for (const raw of profile.parameterRules) {
    const rule = resolveRule(raw);
    if (rule.min === undefined && rule.max === undefined) continue;
    const target = ruleTarget(rule);
    const bag = target.kind === 'param' ? (params ?? curParams) : (extra ?? curExtra);
    const key = target.key;
    const value = bag[key];
    if (typeof value !== 'number') continue;
    if (value >= (rule.min ?? -Infinity) && value <= (rule.max ?? Infinity)) continue;
    if (profile.dropPolicy === 'error') {
      throw engineError('invalid_input', `param ${rule.name} out of range`);
    }
    const clamped = clampNumber(value, rule.min, rule.max);
    if (target.kind === 'param') {
      params = { ...(params ?? curParams) };
      params[key] = clamped;
    } else {
      extra = { ...(extra ?? curExtra) };
      extra[key] = clamped;
    }
  }
  if (params === undefined && extra === undefined) return req;
  return {
    ...req,
    ...(params !== undefined ? { params: params } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}

/**
 * Stage ③ (gate): the capability gate + reasoning downgrade. A thin wrapper over
 * the profile-aware {@link normalizeRequest} (which keeps the four capability
 * 400s and derives the reasoning drop-set from the profile, falling back to the
 * hardcoded lists when the profile declares nothing). Kept here so the engine
 * pipeline reads as ①→①→③→②→④ in one module even though the gate body lives in
 * `@actionow/llm-protocol` (the single normalize call-site).
 */
export function gate(
  req: ChatRequest,
  caps: ModelCapabilities,
  profile: ModelParamProfile | undefined,
): ChatRequest {
  return normalizeRequest(req, caps, profile);
}

/**
 * Stage ④ (dropUnsupported): prune known-standard sampling keys the profile does
 * not declare, per `dropPolicy` — a thin throwing wrapper over the pure
 * {@link dropUnsupportedBody} (contracts). `passthrough`/empty → the SAME body
 * reference (regression invariant). Under `error`, a pruned key becomes a 400.
 * NON-standard `extra` keys are never touched.
 */
export function dropUnsupported(
  body: Record<string, unknown>,
  profile: ModelParamProfile | undefined,
): Record<string, unknown> {
  const { body: next, dropped } = dropUnsupportedBody(body, profile);
  if (dropped.length > 0 && profile?.dropPolicy === 'error') {
    throw engineError('invalid_input', `unsupported params: ${dropped.join(', ')}`);
  }
  return next;
}
