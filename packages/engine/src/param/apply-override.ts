// packages/engine/src/param/apply-override.ts
//
// Engine pipeline stage ② — per-(model×channel) parameter override.
//
// A PURE transform: given the normalized IR `ChatRequest` and a channel's
// `ParamOverride` (loaded from `channel_model.param_override`, mig 0062), apply
// the `set`/`clamp`/`delete` ops and return a NEW IR. NEVER mutates its input
// (deep-cloned first) — the source IR is shared across candidate channels in a
// failover loop, so per-attempt isolation is mandatory.
//
// REGRESSION INVARIANT: an empty (`{ ops: [] }`) or `undefined` override returns
// the IR reference UNCHANGED — byte-for-byte identical to today's wire body.
//
// `set` SEMANTICS = HARD FORCE. An op runs on the already-normalized IR (which
// already carries the caller's request value), so `set` overrides whatever the
// caller sent — this matches new-api's `ParamOverride` and the operator intent
// "force this param on this channel". (The design doc's literal precedence line
// `request > ② > ①` is flagged as a reviewer concern; the authoritative Phase-0
// unit matrix O-2 requires override-wins, so hard-force is what ships.)
import type { ChatParams, ChatRequest, ParamOpDef, ParamOverride } from '@actionow/contracts';

/**
 * The known-standard OpenAI sampling params, keyed by the WIRE (snake_case) name
 * an operator writes in an override op → the camelCase IR `params` field the
 * adapter dialect reads. An op targeting one of these names lands in `req.params`
 * (so the adapter renders it); anything else (unknown key, or a dotted path)
 * rides `req.extra` (the open passthrough bag), matching the dialect parser's own
 * "promote known, passthrough the rest" split.
 */
const WIRE_TO_PARAM: Readonly<Record<string, keyof ChatParams>> = {
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

/** True when a value is a plain (non-array, non-null) object we can descend into. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Clamp a numeric value to the op's `min`/`max`; non-numbers pass through untouched. */
function clampValue(current: unknown, op: ParamOpDef): unknown {
  if (typeof current !== 'number') return current;
  let next = current;
  if (op.min !== undefined && next < op.min) next = op.min;
  if (op.max !== undefined && next > op.max) next = op.max;
  return next;
}

/**
 * Apply one op that targets a known-standard param (lands in `params`). Mutates
 * the passed `params` record (already a clone). Returns nothing.
 */
function applyToParams(params: Record<string, unknown>, key: string, op: ParamOpDef): void {
  switch (op.op) {
    case 'set':
      params[key] = op.value;
      break;
    case 'clamp':
      if (key in params) params[key] = clampValue(params[key], op);
      break;
    case 'delete':
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete params[key];
      break;
  }
}

/**
 * Apply one op that targets `extra` via a (possibly dotted) path. Mutates the
 * passed `extra` record (already a clone). Creates intermediate objects for a
 * `set` on a missing nested path; a `clamp`/`delete` on an absent path is a
 * silent no-op.
 */
function applyToExtra(extra: Record<string, unknown>, op: ParamOpDef): void {
  const segments = op.name.split('.').filter((s) => s.length > 0);
  const last = segments.pop();
  if (last === undefined) return; // empty/blank path → no-op (schema forbids anyway)

  // Descend (creating containers only for `set`) to the parent of the leaf.
  let node: Record<string, unknown> = extra;
  for (const seg of segments) {
    const child = node[seg];
    if (isRecord(child)) {
      node = child;
    } else if (op.op === 'set') {
      const created: Record<string, unknown> = {};
      node[seg] = created;
      node = created;
    } else {
      return; // clamp/delete on a non-existent branch → no-op
    }
  }

  switch (op.op) {
    case 'set':
      node[last] = op.value;
      break;
    case 'clamp':
      if (last in node) node[last] = clampValue(node[last], op);
      break;
    case 'delete':
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete node[last];
      break;
  }
}

/**
 * Engine stage ② — apply a channel's `param_override` to the IR.
 *
 * @param ir       the normalized IR request (already through `normalizeRequest`).
 * @param override the per-(model,channel) override, or `undefined` when unset.
 * @param ctx      `{ modelName }` — the resolved upstream model id, for `when.modelMatches`.
 * @returns a NEW IR with the ops applied, or the SAME `ir` reference when the
 *          override is empty/undefined (the regression invariant).
 */
export function applyChannelOverride(
  ir: ChatRequest,
  override: ParamOverride | undefined,
  ctx: { modelName: string },
): ChatRequest {
  const ops = override?.ops;
  if (ops === undefined || ops.length === 0) return ir;

  // Filter by `when.modelMatches` (substring match on the resolved upstream id).
  const applicable = ops.filter(
    (op) => op.when?.modelMatches === undefined || ctx.modelName.includes(op.when.modelMatches),
  );
  if (applicable.length === 0) return ir;

  // Deep-clone so the source IR (shared across candidate channels) is untouched.
  const next = structuredClone(ir);
  const params: Record<string, unknown> = { ...(next.params ?? {}) };
  const extra: Record<string, unknown> = { ...(next.extra ?? {}) };

  for (const op of applicable) {
    // A dotted name always addresses `extra`; a bare name that is a known-standard
    // sampling param lands in `params`, otherwise it too rides `extra`.
    const paramKey = op.name.includes('.') ? undefined : WIRE_TO_PARAM[op.name];
    if (paramKey !== undefined) {
      applyToParams(params, paramKey, op);
    } else {
      applyToExtra(extra, op);
    }
  }

  return {
    ...next,
    params,
    extra,
  };
}
