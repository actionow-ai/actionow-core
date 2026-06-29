import type { ChatParams, ChatRequest } from '@actionow/contracts';

import type { ModelCapabilities } from './capabilities.js';
import { ProtocolError } from './errors.js';

/**
 * The IR `params` fields a reasoning model rejects: the sampling knobs
 * (temperature/top_p) and `stop`. Dropped (not forwarded) when the model has the
 * `reasoning` capability, so we avoid the upstream 400 storm.
 */
const REASONING_DROPPED_PARAMS = ['temperature', 'topP', 'stop'] as const satisfies readonly (keyof ChatParams)[];

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
 */
export function normalizeRequest(req: ChatRequest, caps: ModelCapabilities): ChatRequest {
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

  return caps.reasoning === true ? downgradeForReasoning(req) : req;
}

/**
 * Return a copy of `bag` with `dropKeys` removed, or the SAME reference when none
 * were present (so callers can cheaply detect "nothing changed"). Rebuilds by
 * copying the kept entries rather than `delete` (which lint forbids on computed
 * keys), and never resurrects keys with an `undefined` value.
 */
function withoutKeys<T extends Record<string, unknown>>(
  bag: T,
  dropKeys: ReadonlySet<string>,
): T {
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
 * Return a copy of `req` with the reasoning-rejected params/extra keys removed.
 * Only allocates new `params`/`extra` objects when there is something to drop, so
 * a clean request is returned (same reference) untouched in shape.
 */
function downgradeForReasoning(req: ChatRequest): ChatRequest {
  const params = req.params === undefined ? undefined : withoutKeys(req.params, REASONING_DROPPED_PARAM_SET);
  const extra = req.extra === undefined ? undefined : withoutKeys(req.extra, REASONING_DROPPED_EXTRA_SET);

  if (params === req.params && extra === req.extra) {
    return req;
  }
  return {
    ...req,
    ...(params !== undefined ? { params } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}
