// packages/engine/src/param/require-params.ts
//
// `require_params` routing predicate (模型参数绑定 Phase 2, D3) — DEFAULT OFF.
//
// A PURE, side-effect-free helper deciding whether a candidate channel "supports"
// every param the request carries under the channel's effective (model,channel)
// config. Used by the API router (`ChannelRoutingService.candidatesFor`) to SKIP a
// non-supporting channel when a route group opts into `require_params`, instead of
// the default OpenRouter drop-and-forward.
//
// A channel does NOT support a request param when EITHER:
//   (1) its `param_override` has a `delete` op (whose `when.modelMatches` applies)
//       targeting that param — the per-channel differentiator ("channel A strips
//       top_p, channel B keeps it"); OR
//   (2) the model's `param_profile.dropPolicy` is `drop`/`error` AND the param is a
//       known-standard sampling param NOT declared in `parameterRules` (the model
//       profile prunes it uniformly on every channel).
//
// REGRESSION INVARIANT: this module is only ever CALLED when a route group has
// `require_params = true`. With it OFF (the default) the router never invokes this,
// so candidate sets are byte-for-byte identical to today.
import type {
  ChatRequest,
  ModelParamProfile,
  ParamOpDef,
  ParamOverride,
} from '@actionow/contracts';
import { KNOWN_STANDARD_WIRE_PARAMS, resolveRule } from '@actionow/contracts';

/**
 * Map an IR `params` (camelCase) key → its OpenAI WIRE (snake_case) name, so the
 * request's declared params compare against override/profile targets (which
 * operators write in wire form). Mirrors the split in `apply-override.ts` /
 * `dropUnsupportedBody`. A param not in this table rides `extra` verbatim.
 */
const IR_PARAM_TO_WIRE: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  topP: 'top_p',
  maxOutputTokens: 'max_tokens',
  stop: 'stop',
  seed: 'seed',
  responseFormat: 'response_format',
  reasoningEffort: 'reasoning_effort',
};

/** Map an override/rule NAME (wire or IR form) → its canonical wire name. */
const NAME_TO_WIRE: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  top_p: 'top_p',
  topP: 'top_p',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_tokens',
  maxOutputTokens: 'max_tokens',
  max_output_tokens: 'max_tokens',
  stop: 'stop',
  seed: 'seed',
  response_format: 'response_format',
  responseFormat: 'response_format',
  reasoning_effort: 'reasoning_effort',
  reasoningEffort: 'reasoning_effort',
};

/**
 * The set of WIRE param names the request carries — the union of the standard
 * `params` (mapped to wire names) and the top-level `extra` keys (model-specific
 * declared params). Only NON-dotted extra keys are considered (a dotted `extra`
 * path is a nested field, not a top-level param an operator gates on).
 */
export function requestParamNames(ir: ChatRequest): Set<string> {
  const names = new Set<string>();
  const params = (ir.params ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    names.add(IR_PARAM_TO_WIRE[k] ?? k);
  }
  for (const k of Object.keys(ir.extra ?? {})) {
    if (!k.includes('.')) names.add(k);
  }
  return names;
}

/** The wire names a channel's override `delete` ops strip (scoped by `when.modelMatches`). */
function overrideDeletedNames(override: ParamOverride | undefined, modelName: string): Set<string> {
  const deleted = new Set<string>();
  for (const op of override?.ops ?? ([] as ParamOpDef[])) {
    if (op.op !== 'delete') continue;
    if (op.when?.modelMatches !== undefined && !modelName.includes(op.when.modelMatches)) continue;
    // A dotted path deletes a nested `extra` field — treat its ROOT as the param
    // name so `delete thinking.budget` gates on the `thinking` param.
    const root = op.name.split('.')[0] ?? op.name;
    deleted.add(NAME_TO_WIRE[root] ?? root);
  }
  return deleted;
}

/** The known-standard wire names the model profile prunes (dropPolicy drop/error, undeclared). */
function profileDroppedNames(profile: ModelParamProfile | undefined): Set<string> {
  const dropped = new Set<string>();
  if (profile === undefined || profile.dropPolicy === 'passthrough') return dropped;
  const allowed = new Set<string>();
  for (const rule of profile.parameterRules) {
    const name = resolveRule(rule).name;
    allowed.add(NAME_TO_WIRE[name] ?? name);
    allowed.add(name);
  }
  for (const wire of KNOWN_STANDARD_WIRE_PARAMS) {
    if (!allowed.has(wire)) dropped.add(wire);
  }
  return dropped;
}

/**
 * `require_params` predicate: does this channel SUPPORT every param the request
 * carries (i.e. would drop NONE of them)? Returns `true` when the channel keeps
 * every request param → routable; `false` when it would strip at least one →
 * skip it (the router falls to the next candidate, or 404s if none support).
 *
 * @param requested wire param names the request declared ({@link requestParamNames}).
 * @param override  the channel's per-(model,channel) override (stamped on the RunChannel).
 * @param profile   the model's frozen param profile (uniform across channels).
 * @param modelName the resolved upstream model id (for `when.modelMatches`).
 */
export function channelSupportsParams(
  requested: ReadonlySet<string>,
  override: ParamOverride | undefined,
  profile: ModelParamProfile | undefined,
  modelName: string,
): boolean {
  if (requested.size === 0) return true;
  const deleted = overrideDeletedNames(override, modelName);
  const profileDropped = profileDroppedNames(profile);
  for (const name of requested) {
    if (deleted.has(name) || profileDropped.has(name)) return false;
  }
  return true;
}
