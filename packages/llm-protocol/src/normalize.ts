import type { ChatParams, ChatRequest, ModelParamProfile } from '@actionow/contracts';
import { resolveRule } from '@actionow/contracts';

import type { ModelCapabilities } from './capabilities.js';
import { ProtocolError } from './errors.js';

/**
 * The IR `params` fields a reasoning model rejects: the sampling knobs
 * (temperature/top_p) and `stop`. Dropped (not forwarded) when the model has the
 * `reasoning` capability, so we avoid the upstream 400 storm.
 *
 * FALLBACK constant: this hardcoded list drives the downgrade ONLY when the
 * resolved model carries NO profile (or a profile that declares nothing about
 * reasoning). When the profile IS reasoning-aware, `downgradeByProfile` derives
 * the drop-set from the profile's allow-list instead (per-model, not global).
 */
const REASONING_DROPPED_PARAMS = [
  'temperature',
  'topP',
  'stop',
] as const satisfies readonly (keyof ChatParams)[];

/**
 * The `extra`-bag (snake_case wire) keys a reasoning model rejects: penalties and
 * the logprobs family. Dropped from `req.extra` when the model is a reasoning
 * model. (`top_p`/`temperature` cannot also arrive via `extra` — the parser
 * promotes them to first-class params and excludes them from `extra`.)
 */
const REASONING_DROPPED_EXTRA = [
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'logprobs',
  'top_logprobs',
] as const;

/**
 * Gate an IR `ChatRequest` against a model's capabilities. Unsupported feature
 * → `ProtocolError('invalid_input', ...)` (the API renders a 400 per dialect).
 *
 * For a `reasoning`-capability model, instead of 400-ing on the sampling params
 * such models reject, this DOWNGRADES them: it strips temperature/top_p/stop from
 * `params` and penalties/logprobs from the `extra` passthrough bag, returning a
 * cleaned copy. The genuine capability misuses (tools/json/vision/audio/file
 * unsupported) still 400. A non-reasoning model is returned unchanged.
 *
 * PROFILE-DRIVEN (Phase 1): when a non-empty `profile` is supplied AND it
 * declares reasoning handling ({@link hasReasoningRules}), the reasoning
 * downgrade is derived from the profile's allow-list ({@link downgradeByProfile})
 * instead of the hardcoded {@link REASONING_DROPPED_PARAMS}/`_EXTRA`. When the
 * profile is absent/empty OR declares nothing about reasoning, the FALLBACK is
 * today's exact hardcoded behavior — so an empty profile is byte-for-byte
 * identical to before Phase 1 (the regression invariant). The capability-misuse
 * gate (the four 400s) is UNCHANGED regardless of profile.
 */
export function normalizeRequest(
  req: ChatRequest,
  caps: ModelCapabilities,
  profile?: ModelParamProfile,
): ChatRequest {
  if (req.tools !== undefined && req.tools.length > 0 && !caps.tools) {
    throw new ProtocolError('invalid_input', 'model does not support tools');
  }
  const wantsJson =
    req.params?.responseFormat === 'json_object' || req.params?.responseFormat === 'json_schema';
  if (wantsJson && !caps.json) {
    throw new ProtocolError('invalid_input', 'model does not support structured output');
  }
  for (const m of req.messages) {
    for (const part of m.content) {
      if (part.kind === 'image' && !caps.vision) {
        throw new ProtocolError('invalid_input', 'model does not support image input');
      }
      if (part.kind === 'audio' && !caps.audio) {
        throw new ProtocolError('invalid_input', 'model does not support audio input');
      }
      if (part.kind === 'file' && caps.file !== true) {
        throw new ProtocolError('invalid_input', 'model does not support file input');
      }
    }
  }

  // Reasoning downgrade — PROFILE-DRIVEN with fallback to the hardcoded lists.
  if (profile !== undefined && hasReasoningRules(profile)) {
    return downgradeByProfile(req, profile);
  }
  return caps.reasoning === true ? downgradeForReasoning(req) : req;
}

/**
 * Return a copy of `bag` with `dropKeys` removed, or the SAME reference when none
 * were present (so callers can cheaply detect "nothing changed"). Rebuilds by
 * copying the kept entries rather than `delete` (which lint forbids on computed
 * keys), and never resurrects keys with an `undefined` value.
 */
function withoutKeys<T extends Record<string, unknown>>(bag: T, dropKeys: ReadonlySet<string>): T {
  if (!Object.keys(bag).some((k) => dropKeys.has(k))) {
    return bag;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (dropKeys.has(k)) continue;
    out[k] = v;
  }
  return out as T;
}

const REASONING_DROPPED_PARAM_SET: ReadonlySet<string> = new Set(REASONING_DROPPED_PARAMS);
const REASONING_DROPPED_EXTRA_SET: ReadonlySet<string> = new Set(REASONING_DROPPED_EXTRA);

/**
 * Return a copy of `req` with the reasoning-rejected params/extra keys removed
 * using the supplied drop-sets. Only allocates new `params`/`extra` objects when
 * there is something to drop, so a clean request is returned (same reference)
 * untouched in shape. Shared by the hardcoded fallback and the profile-driven
 * paths so both keep the same-reference-when-clean optimization.
 */
function downgradeWithSets(
  req: ChatRequest,
  paramSet: ReadonlySet<string>,
  extraSet: ReadonlySet<string>,
): ChatRequest {
  const params = req.params === undefined ? undefined : withoutKeys(req.params, paramSet);
  const extra = req.extra === undefined ? undefined : withoutKeys(req.extra, extraSet);

  if (params === req.params && extra === req.extra) {
    return req;
  }
  return {
    ...req,
    ...(params !== undefined ? { params } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}

/** The hardcoded FALLBACK reasoning downgrade (pre-Phase-1 behavior, verbatim). */
function downgradeForReasoning(req: ChatRequest): ChatRequest {
  return downgradeWithSets(req, REASONING_DROPPED_PARAM_SET, REASONING_DROPPED_EXTRA_SET);
}

/**
 * The IR `params` (camelCase) names of the standard sampling/penalty knobs a
 * reasoning model may reject, paired with the wire (snake_case) name they'd carry
 * in `extra`. A profile whose `parameterRules` do NOT allow a given knob drops it
 * (per-model, mirroring LiteLLM `get_supported_openai_params`).
 */
const REASONING_CANDIDATE_PARAMS = ['temperature', 'topP', 'stop'] as const;
const REASONING_CANDIDATE_EXTRA = [
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'logprobs',
  'top_logprobs',
] as const;

/** camelCase IR params ⇄ their wire (snake_case) name, for matching profile rule names. */
const PARAM_WIRE_NAME: Readonly<Record<string, string>> = {
  temperature: 'temperature',
  topP: 'top_p',
  stop: 'stop',
};

/**
 * True iff the profile declares reasoning handling: it lists `reasoning` in
 * `features`. Only then does the profile-driven downgrade run; otherwise the
 * hardcoded fallback (keyed on `caps.reasoning`) applies — so a profile that says
 * nothing about reasoning never changes today's behavior.
 */
export function hasReasoningRules(profile: ModelParamProfile): boolean {
  return profile.features.includes('reasoning');
}

/**
 * Build the drop-set from the profile's allow-list: any standard sampling/penalty
 * knob NOT named (by IR name OR its wire alias) in `profile.parameterRules` is
 * dropped for this reasoning model. Reuses `downgradeWithSets` so the
 * same-reference-when-clean optimization holds.
 */
function downgradeByProfile(req: ChatRequest, profile: ModelParamProfile): ChatRequest {
  const allowed = new Set<string>();
  for (const rule of profile.parameterRules) {
    const name = resolveRule(rule).name;
    allowed.add(name);
    const wire = PARAM_WIRE_NAME[name];
    if (wire !== undefined) allowed.add(wire);
  }
  const paramSet = new Set(
    REASONING_CANDIDATE_PARAMS.filter(
      (p) => !allowed.has(p) && !allowed.has(PARAM_WIRE_NAME[p] ?? p),
    ),
  );
  const extraSet = new Set(REASONING_CANDIDATE_EXTRA.filter((k) => !allowed.has(k)));
  return downgradeWithSets(req, paramSet, extraSet);
}
