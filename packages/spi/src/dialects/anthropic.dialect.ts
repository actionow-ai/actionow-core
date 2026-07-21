// packages/spi/src/dialects/anthropic.dialect.ts
//
// model-supply-greenfield 批次2 wave2 — the ANTHROPIC Messages dialect, authored
// as a CODE aspect set (§6 六切面; authoring mode = code, NOT DSL). This is the
// intended 「首个代码切面样例」: it clears the SAME seven-gate `describeConformance`
// suite the DSL mock-vendor pack does, proving the two authoring tracks are
// EQUIVALENT at the gate (判据: 代码切面与 DSL 方言在同一 describeConformance 下
// 等价过门).
//
// Why code and not DSL: Anthropic streaming carries NAMED SSE events whose
// discriminator is the JSON `type` field, and correct normalization needs four
// things the DSL streamSpecSchema structurally cannot express —
//   (1) extract the NESTED delta (`delta.text` / `delta.partial_json`),
//   (2) DROP administrative frames (message_start / content_block_* / ping …),
//   (3) FOLD usage split across two events (input_tokens on message_start,
//       cumulative output_tokens on message_delta) into ONE terminal done frame
//       via StreamNormalizationState,
//   (4) TERMINATE on `message_stop` — there is NO [DONE] sentinel.
// A DSL pack would MECHANICALLY pass gate 4 (which only checks reassembly /
// no-hang / overflow / determinism) yet emit raw-JSON deltas with no assembled
// usage — semantically broken. Hence code.
//
// Aspect surface: ① request mapping (pure wire porterage, §4.1 red line — reads
// EffectiveParams.upstream ONLY, injects NO defaults, does NO value scaling),
// ③ credential injection (x-api-key header; the anthropic-version header is a
// STATIC protocol constant set in ①, not a credential), ⑤ response
// normalization (buffered + streaming), and the per-provider error table.
// chat.completions is direct+stream only: no media aspect (②) and no task
// aspect (⑥) — chat vision media rides INSIDE messages content blocks, never as
// a top-level media param — so conformance gates 3 (media) and 5 (task) SKIP
// legitimately.
//
// Depends on @actionow/contracts + the spi-internal aspect surface ONLY (§14.5).
import type { CredentialSecret, GatewayUsage } from '@actionow/contracts';
import { gatewayUsageSchema } from '@actionow/contracts';

import type {
  Dialect,
  ErrorProbe,
  ErrorTable,
  NormalizedResponse,
  RequestMappingInput,
  StreamFrameResult,
  StreamNormalizationState,
  WireRequestDraft,
  WireResponse,
} from '../aspects.js';
import { resolveError } from '../aspects.js';

// --- provider constants -------------------------------------------------------

/** Provider slug carried onto every GatewayError's upstream provenance (§9.3). */
const PROVIDER = 'anthropic';

/**
 * Anthropic's Messages API REQUIRES `max_tokens` on EVERY request — omitting it
 * is a hard 400 (`Invalid request: max_tokens: Field required`). The canonical
 * IR / golden probe only carries a max-output cap when the model declares one,
 * so most offerings would arrive without it. The dialect injects this sane
 * default whenever no caller value is present, so every Anthropic call (probe +
 * real, streaming + sync) always ships a valid `max_tokens`.
 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * The Messages API protocol version header — a STATIC constant the API requires
 * on every call, NOT a credential (so it lives in aspect ①'s request draft, and
 * gate 1 sees it as an ordinary header, never as signing/secret material).
 */
const ANTHROPIC_VERSION = '2023-06-01';

// --- untyped-wire access helpers (no `any` leaks) -----------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read one field off an unknown value, or undefined when it is not an object. */
function getField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Parse a wire frame's JSON, or undefined on malformed input (never throws). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// --- error table (§6-⑤ Anthropic error codes → unified taxonomy) ---------------

/**
 * Ground truth mirrors the legacy adapter's httpStatusToUnified, re-split for
 * the SPI taxonomy. Every {@link STANDARD_ERROR_PROBES} tier
 * (400/401/403/404/408/429/500/502/503/504/timeout/network) lands on an
 * EXPLICIT row (gate 6 completeness), with retryable/failover chosen so the
 * soft-flag sanity check warns on none. The two `upstreamCode` rows are pure
 * defense (Anthropic's 529 overload / rate-limit code); a real 529 is already
 * caught by the [500,599] range, so they never shadow a standard probe.
 * `fallback` makes the table total by construction.
 */
const errorTable: ErrorTable = {
  rows: [
    { match: { httpStatus: 400 }, code: 'invalid_input', retryable: false, failover: false },
    { match: { httpStatus: 401 }, code: 'unauthorized', retryable: false, failover: true },
    { match: { httpStatus: 403 }, code: 'forbidden', retryable: false, failover: true },
    { match: { httpStatus: 404 }, code: 'model_not_found', retryable: false, failover: true },
    { match: { httpStatus: 408 }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
    // Defensive upstreamCode rows BEFORE the 5xx range so an explicit
    // overload/rate-limit code wins when it rides a non-5xx status; standard
    // probes carry no upstreamCode, so these never shadow them.
    {
      match: { upstreamCode: 'overloaded_error' },
      code: 'upstream_error',
      retryable: true,
      failover: true,
    },
    {
      match: { upstreamCode: 'rate_limit_error' },
      code: 'rate_limited',
      retryable: true,
      failover: true,
    },
    { match: { httpStatus: [500, 599] }, code: 'upstream_error', retryable: true, failover: true },
    { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: true },
};

// --- usage extraction (§9.2) --------------------------------------------------

/** Anthropic usage block (buffered 200) → gateway metrics; mirrors adapter extractUsage + addAnthropicBreakdown. */
function extractUsage(rawUsage: unknown): GatewayUsage {
  const metrics: Record<string, number> = {};
  const input = asNumber(getField(rawUsage, 'input_tokens'));
  if (input !== undefined) metrics.input_tokens = input;
  const output = asNumber(getField(rawUsage, 'output_tokens'));
  if (output !== undefined) metrics.output_tokens = output;
  const cacheRead = asNumber(getField(rawUsage, 'cache_read_input_tokens'));
  if (cacheRead !== undefined) metrics.cached_input_tokens = cacheRead;
  const cacheCreate = asNumber(getField(rawUsage, 'cache_creation_input_tokens'));
  if (cacheCreate !== undefined) metrics.cache_creation_tokens = cacheCreate;
  return gatewayUsageSchema.parse({ metrics });
}

/**
 * Fold the usage accumulated across the two streaming events into the terminal
 * done frame's GatewayUsage: input_tokens (+cache split) arrived on
 * message_start; the cumulative last-wins output_tokens on message_delta.
 */
function assembleStreamUsage(state: StreamNormalizationState): GatewayUsage {
  const metrics: Record<string, number> = {};
  const input = asNumber(state.inputTokens);
  if (input !== undefined) metrics.input_tokens = input;
  const output = asNumber(state.outputTokens);
  if (output !== undefined) metrics.output_tokens = output;
  const cacheRead = asNumber(state.cacheReadInputTokens);
  if (cacheRead !== undefined) metrics.cached_input_tokens = cacheRead;
  const cacheCreate = asNumber(state.cacheCreationInputTokens);
  if (cacheCreate !== undefined) metrics.cache_creation_tokens = cacheCreate;
  return gatewayUsageSchema.parse({ metrics });
}

// --- aspect ⑤: response normalization -----------------------------------------

/**
 * Buffered normalize (§6-⑤). A 200 is ALWAYS a valid message (Anthropic carries
 * no 200-embedded business error) → surface the content blocks + usage. Every
 * non-2xx routes through the error table on error.type / error.message.
 */
function normalize(res: WireResponse): NormalizedResponse {
  if (res.status >= 200 && res.status < 300) {
    const content = getField(res.body, 'content');
    return {
      ok: true,
      output: content ?? res.body,
      usage: extractUsage(getField(res.body, 'usage')),
    };
  }
  const errorObj = getField(res.body, 'error');
  const upstreamCode = asString(getField(errorObj, 'type'));
  const message = asString(getField(errorObj, 'message')) ?? res.text;
  const probe: ErrorProbe = { httpStatus: res.status, provider: PROVIDER };
  if (upstreamCode !== undefined) probe.upstreamCode = upstreamCode;
  if (message !== undefined) probe.message = message;
  return { ok: false, error: resolveError(errorTable, probe) };
}

/**
 * Streaming normalize (§6-⑤). The pipeline framer joins `data:` lines and DROPS
 * the `event:` name, so dispatch is on the JSON `type` field (exactly like the
 * working adapter), never the SSE event line. Administrative frames emit `[]`;
 * usage is accumulated in `state`; the stream TERMINATES on `message_stop`
 * (no [DONE]) or on a mid-stream `error` event.
 */
function normalizeStreamFrame(
  rawFrame: string,
  state: StreamNormalizationState,
): StreamFrameResult {
  const parsed = parseJson(rawFrame);
  const type = asString(getField(parsed, 'type'));
  switch (type) {
    case 'message_start': {
      const usage = getField(getField(parsed, 'message'), 'usage');
      const input = asNumber(getField(usage, 'input_tokens'));
      if (input !== undefined) state.inputTokens = input;
      const cacheRead = asNumber(getField(usage, 'cache_read_input_tokens'));
      if (cacheRead !== undefined) state.cacheReadInputTokens = cacheRead;
      const cacheCreate = asNumber(getField(usage, 'cache_creation_input_tokens'));
      if (cacheCreate !== undefined) state.cacheCreationInputTokens = cacheCreate;
      const output = asNumber(getField(usage, 'output_tokens'));
      if (output !== undefined) state.outputTokens = output;
      return [];
    }
    case 'content_block_start': {
      const block = getField(parsed, 'content_block');
      if (asString(getField(block, 'type')) === 'tool_use') {
        return [
          {
            kind: 'delta',
            payload: {
              index: asNumber(getField(parsed, 'index')),
              toolUse: {
                id: asString(getField(block, 'id')),
                name: asString(getField(block, 'name')),
              },
            },
          },
        ];
      }
      return [];
    }
    case 'content_block_delta': {
      const delta = getField(parsed, 'delta');
      const deltaType = asString(getField(delta, 'type'));
      if (deltaType === 'text_delta') {
        return [{ kind: 'delta', payload: asString(getField(delta, 'text')) ?? '' }];
      }
      if (deltaType === 'input_json_delta') {
        return [
          {
            kind: 'delta',
            payload: {
              index: asNumber(getField(parsed, 'index')),
              argumentsDelta: asString(getField(delta, 'partial_json')) ?? '',
            },
          },
        ];
      }
      return [];
    }
    case 'content_block_stop':
      return [];
    case 'message_delta': {
      const output = asNumber(getField(getField(parsed, 'usage'), 'output_tokens'));
      if (output !== undefined) state.outputTokens = output;
      const stopReason = asString(getField(getField(parsed, 'delta'), 'stop_reason'));
      if (stopReason !== undefined) state.stopReason = stopReason;
      return [];
    }
    case 'message_stop':
      return [{ kind: 'done', usage: assembleStreamUsage(state) }];
    case 'ping':
      return [];
    case 'error': {
      const errorObj = getField(parsed, 'error');
      const upstreamCode = asString(getField(errorObj, 'type'));
      const message = asString(getField(errorObj, 'message'));
      const probe: ErrorProbe = { provider: PROVIDER };
      if (upstreamCode !== undefined) probe.upstreamCode = upstreamCode;
      if (message !== undefined) probe.message = message;
      return { error: resolveError(errorTable, probe) };
    }
    default:
      return [];
  }
}

// --- aspect ①: request mapping (§6-①, §4.1 layer-3 red line) -------------------

/**
 * IR → Anthropic wire request. Structure porterage: body = { model,
 * ...params.upstream } (upstream wire names already renamed/hoisted upstream of
 * the SPI — the dialect places them VERBATIM), with ONE dialect-owned safety
 * net: `max_tokens` is REQUIRED by the Messages API, so when neither the caller
 * nor the offering supplied one the dialect injects {@link DEFAULT_MAX_TOKENS}.
 * This is a wire-protocol requirement (a missing field the API rejects), not a
 * value-domain re-map — a caller-provided `max_tokens` is always preserved. No
 * other value scaling happens here. On the stream path it additionally sets
 * `stream: true`; the static protocol header rides in every draft.
 */
function mapRequest(input: RequestMappingInput): WireRequestDraft {
  const body: Record<string, unknown> = {
    model: input.upstreamModelName,
    ...input.params.upstream,
  };
  // Guarantee the API-required max_tokens on EVERY call (probe + real, stream +
  // sync). Keep any caller/offering value; only default when absent.
  // `??=` fills in the API-required max_tokens for both an omitted field and an
  // explicit `null` (some OpenAI-compatible clients send `max_tokens: null` to
  // mean "no cap", which Anthropic rejects); an explicit 0 is preserved.
  body.max_tokens ??= DEFAULT_MAX_TOKENS;
  if (input.stream) body.stream = true;
  return {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'anthropic-version': ANTHROPIC_VERSION },
    bodyKind: 'json',
    body,
  };
}

// --- aspect ③: credential injection (§6-③) ------------------------------------

/**
 * Inject the channel's x_api_key secret into the `x-api-key` header. Returns a
 * NEW draft (spread headers — never mutate; the pipeline deep-freezes ③'s
 * output) that PRESERVES the static anthropic-version header from aspect ①.
 */
function injectCredential(draft: WireRequestDraft, secret: CredentialSecret): WireRequestDraft {
  if (secret.scheme !== 'x_api_key') {
    throw new TypeError(
      `anthropic dialect requires an x_api_key credential secret; got scheme "${secret.scheme}"`,
    );
  }
  return {
    ...draft,
    headers: { ...(draft.headers ?? {}), 'x-api-key': secret.api_key },
  };
}

// --- dialect aggregate (§6) ---------------------------------------------------

/**
 * The Anthropic Messages dialect, code-authored. chat.completions supports
 * direct + stream; no media / task aspects (chat vision media rides inside the
 * messages content blocks, and Anthropic has no async task endpoint), so the
 * pipeline's default transport serves and conformance gates 3 & 5 SKIP.
 */
export const anthropicDialect: Dialect = {
  ref: 'anthropic',
  version: '1.0.0',
  operations: { 'chat.completions': { fetchModes: ['direct', 'stream'] } },
  requestMapping: { map: mapRequest },
  credentialInjection: { injectCredential },
  responseNormalization: { normalize, normalizeStreamFrame },
  errorTable,
};
