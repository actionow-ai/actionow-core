// packages/spi/src/dialects/openai.dialect.ts
//
// model-supply-greenfield 批次2 wave2 — the BASELINE OpenAI-compatible dialect
// (design docs/plans/draft_2026-07-10_model-supply-greenfield.md §6). Target
// operations: `chat.completions` (direct + stream) and `embeddings` (direct).
//
// WHY CODE, NOT DSL — the wire is 100% DSL-expressible (bearer auth, JSON
// bodies, standard SSE `data: {json}` + `[DONE]`), but the REQUIRED operation
// set forces code authoring: `normalizeStreamFrame(rawFrame, state)`
// (aspects.ts) carries NO ctx/operation, and the DSL engine resolves the stream
// spec via `resolveResponseSpec(pack, undefined)` (engine.ts), which THROWS for
// a pack with >1 `direct|stream` operation. openai has exactly two buffered ops
// (chat.completions{direct,stream} + embeddings{direct}), so a DSL pack's chat
// stream gate would surface a config `error` frame. A hand-authored dialect
// hardcodes the chat.completion.chunk SSE framer (embeddings never streams) and
// serves both operations cleanly.
//
// RED LINE (§4.1 layer 3): aspect ① is PURE wire-structure porterage —
// `params.upstream` already carries the openai snake_case wire names (the
// planner's layer-2 job). No value scaling, no camelCase→snake_case remap, no
// reading of `params.canonical`. The only structural decision aspect ① makes
// beyond placement is adding `stream`/`stream_options` on the stream fetch mode
// (a wire framing flag carried by RequestMappingInput.stream — not a value map).
import type { GatewayUsage, Operation, StreamFrame } from '@actionow/contracts';
import { OPERATIONS } from '@actionow/contracts';

import type {
  CredentialInjectionAspect,
  Dialect,
  DialectContext,
  ErrorProbe,
  ErrorTable,
  NormalizedResponse,
  RequestMappingAspect,
  RequestMappingInput,
  ResponseNormalizationAspect,
  StreamFrameResult,
  StreamNormalizationState,
  WireRequestDraft,
  WireResponse,
} from '../aspects.js';
import { resolveError } from '../aspects.js';

// --- constants ----------------------------------------------------------------

const PROVIDER = 'openai';
const DONE_SENTINEL = '[DONE]';

// --- small typed accessors (no jsonpath dep — direct structural reads) --------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a child key off a value that may not be an object (returns undefined otherwise). */
function getObj(value: unknown, key: string): unknown {
  return isPlainObject(value) ? value[key] : undefined;
}

/** Keep only finite numbers (a present-but-zero count is meaningful — kept). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function mkUsage(metrics: Record<string, number>): GatewayUsage {
  return { metrics, billingDims: {}, estimated: false };
}

/** The operation pinned in ctx (§6: aspect ⑤ carries no operation — the caller pins it). */
function operationFromCtx(ctx: DialectContext | undefined): Operation | undefined {
  const raw = ctx?.config?.operation;
  if (typeof raw !== 'string') return undefined;
  return (OPERATIONS as readonly string[]).includes(raw) ? (raw as Operation) : undefined;
}

// --- usage extraction (§9.2) --------------------------------------------------

/**
 * chat.completions usage: input_tokens←prompt_tokens, output_tokens←
 * completion_tokens, plus the nested present-but-zero breakdown
 * (reasoning/cached/audio) — each metered under its own key so pricing keeps
 * the provider's split.
 */
function extractChatUsage(usageObj: unknown): GatewayUsage {
  const metrics: Record<string, number> = {};
  const prompt = finiteNumber(getObj(usageObj, 'prompt_tokens'));
  if (prompt !== undefined) metrics.input_tokens = prompt;
  const completion = finiteNumber(getObj(usageObj, 'completion_tokens'));
  if (completion !== undefined) metrics.output_tokens = completion;

  const promptDetails = getObj(usageObj, 'prompt_tokens_details');
  const cached = finiteNumber(getObj(promptDetails, 'cached_tokens'));
  if (cached !== undefined) metrics.cached_input_tokens = cached;
  const audioIn = finiteNumber(getObj(promptDetails, 'audio_tokens'));
  if (audioIn !== undefined) metrics.audio_input_tokens = audioIn;

  const completionDetails = getObj(usageObj, 'completion_tokens_details');
  const reasoning = finiteNumber(getObj(completionDetails, 'reasoning_tokens'));
  if (reasoning !== undefined) metrics.reasoning_tokens = reasoning;
  const audioOut = finiteNumber(getObj(completionDetails, 'audio_tokens'));
  if (audioOut !== undefined) metrics.audio_output_tokens = audioOut;

  return mkUsage(metrics);
}

/** embeddings usage: input_tokens←prompt_tokens ONLY (embeddings bills input; no completion). */
function extractEmbeddingsUsage(usageObj: unknown): GatewayUsage {
  const metrics: Record<string, number> = {};
  const prompt = finiteNumber(getObj(usageObj, 'prompt_tokens'));
  if (prompt !== undefined) metrics.input_tokens = prompt;
  return mkUsage(metrics);
}

// --- error table (§6-⑤ per-provider 错误码表 → 统一 taxonomy) --------------------

/**
 * openai errors are HTTP-status-borne, body `{error:{message,type,param,code}}`.
 * First-match-wins order matters: the upstreamCode `insufficient_quota` row must
 * precede the generic 429 row (insufficient_quota IS an HTTP 429, but it is a
 * billing exhaustion → insufficient_credits, non-retryable, failover so another
 * key/offering with credits may serve). The httpStatus/kind rows alone satisfy
 * the STANDARD_ERROR_PROBES completeness gate (which probes no upstreamCode).
 */
export const openaiErrorTable: ErrorTable = {
  rows: [
    {
      match: { upstreamCode: 'insufficient_quota' },
      code: 'insufficient_credits',
      retryable: false,
      failover: true,
    },
    { match: { httpStatus: 400 }, code: 'invalid_input', retryable: false, failover: false },
    { match: { httpStatus: 401 }, code: 'unauthorized', retryable: false, failover: true },
    { match: { httpStatus: 403 }, code: 'forbidden', retryable: false, failover: true },
    { match: { httpStatus: 404 }, code: 'model_not_found', retryable: false, failover: true },
    { match: { httpStatus: 408 }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
    { match: { httpStatus: [500, 599] }, code: 'upstream_error', retryable: true, failover: true },
    { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: true },
};

/**
 * Build an error probe from an openai `{error:{...}}` object. openai frequently
 * leaves `error.code` null and puts the real discriminator in `error.type`, so
 * fall back code→type; rows then match on httpStatus when no code is present.
 */
function errorProbeFromBody(errObj: unknown): { upstreamCode?: string; message?: string } {
  const out: { upstreamCode?: string; message?: string } = {};
  const code = getObj(errObj, 'code') ?? getObj(errObj, 'type');
  if (typeof code === 'string' && code.length > 0) out.upstreamCode = code;
  const message = getObj(errObj, 'message');
  if (typeof message === 'string' && message.length > 0) out.message = message;
  return out;
}

function httpErrorProbe(res: WireResponse): ErrorProbe {
  const probe: ErrorProbe = { httpStatus: res.status, provider: PROVIDER };
  const { upstreamCode, message } = errorProbeFromBody(getObj(res.body, 'error'));
  if (upstreamCode !== undefined) probe.upstreamCode = upstreamCode;
  if (message !== undefined) probe.message = message;
  else if (typeof res.text === 'string' && res.text.length > 0) probe.message = res.text;
  return probe;
}

// --- aspect ①: request mapping (STRUCTURE ONLY, §4.1 layer 3) ------------------

const requestMapping: RequestMappingAspect = {
  map(input: RequestMappingInput): WireRequestDraft {
    const { operation, upstreamModelName, params, stream } = input;
    // Path convention: `/chat/completions` + `/embeddings` relative to a `/v1`
    // baseUrl (channel.base_url = https://api.openai.com/v1).
    const path = operation === 'embeddings' ? '/embeddings' : '/chat/completions';
    // RED LINE: verbatim structure porterage — `params.upstream` keys ARE the
    // openai wire names (planner layer-2 output); `params.canonical` is NEVER
    // read. The offering's upstream_model_name is authoritative for `model`.
    const body: Record<string, unknown> = { model: upstreamModelName, ...params.upstream };
    if (stream && operation !== 'embeddings') {
      // Stream framing flag (from the fetch mode, not a value map). Force the
      // trailing usage chunk so output_tokens are metered on the stream.
      body.stream = true;
      const existing = isPlainObject(params.upstream.stream_options)
        ? params.upstream.stream_options
        : {};
      body.stream_options = { ...existing, include_usage: true };
    }
    return { method: 'POST', path, bodyKind: 'json', body };
  },
};

// --- aspect ③: credential injection (bearer) ----------------------------------

const credentialInjection: CredentialInjectionAspect = {
  injectCredential(draft, secret): WireRequestDraft {
    if (secret.scheme !== 'bearer') {
      throw new TypeError(
        `openai dialect expects a bearer credential; got secret scheme "${secret.scheme}"`,
      );
    }
    return {
      ...draft,
      headers: { ...(draft.headers ?? {}), Authorization: `Bearer ${secret.api_key}` },
    };
  },
};

// --- aspect ⑤: response normalization -----------------------------------------

/**
 * Extract a chat.completion.chunk delta. Text delta = choices[0].delta.content
 * (emitted only when non-empty); tool-call delta = choices[0].delta.tool_calls.
 * The trailing usage chunk carries `usage` with an EMPTY `choices:[]`, so the
 * choices[0] read MUST tolerate absent choices (no spurious empty delta).
 */
function chunkDeltaFrames(parsed: Record<string, unknown>): StreamFrame[] {
  const choices = parsed.choices;
  const choice = Array.isArray(choices) ? (choices[0] as unknown) : undefined;
  const delta = getObj(choice, 'delta');
  if (delta === undefined) return [];
  const content = getObj(delta, 'content');
  if (typeof content === 'string' && content.length > 0) {
    return [{ kind: 'delta', payload: content }];
  }
  const toolCalls = getObj(delta, 'tool_calls');
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return [{ kind: 'delta', payload: { tool_calls: toolCalls } }];
  }
  // role-only / empty delta → administrative frame (nothing to forward).
  return [];
}

const responseNormalization: ResponseNormalizationAspect = {
  normalize(res: WireResponse, ctx: DialectContext): NormalizedResponse {
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: resolveError(openaiErrorTable, httpErrorProbe(res)) };
    }
    // openai chat/embeddings carry NO 200-business error — HTTP status is the
    // sole error signal. Dispatch output/usage extraction by the pinned
    // operation (aspect ⑤ carries no operation; the caller pins ctx.config).
    const operation = operationFromCtx(ctx);
    const body = res.body;
    if (operation === 'embeddings') {
      return {
        ok: true,
        output: getObj(body, 'data'),
        usage: extractEmbeddingsUsage(getObj(body, 'usage')),
      };
    }
    // default: chat.completions (output = the choices array; downstream reads
    // choices[0].message.content / tool_calls / finish_reason).
    return {
      ok: true,
      output: getObj(body, 'choices'),
      usage: extractChatUsage(getObj(body, 'usage')),
    };
  },

  normalizeStreamFrame(rawFrame: string, state: StreamNormalizationState): StreamFrameResult {
    if (rawFrame === DONE_SENTINEL) {
      const usage = state.usage as GatewayUsage | undefined;
      return [usage !== undefined ? { kind: 'done', usage } : { kind: 'done' }];
    }
    const parsed = tryParseJson(rawFrame);
    if (!isPlainObject(parsed)) return []; // tolerate non-JSON administrative frames
    // Mid-stream error frame (v0.0.9): `data: {"error":{...}}` and the stream
    // ends WITHOUT [DONE] → map to a terminal error (not a delta).
    const errObj = parsed.error;
    if (errObj !== undefined && errObj !== null) {
      const { upstreamCode, message } = errorProbeFromBody(errObj);
      const probe: ErrorProbe = { provider: PROVIDER };
      if (upstreamCode !== undefined) probe.upstreamCode = upstreamCode;
      if (message !== undefined) probe.message = message;
      return { error: resolveError(openaiErrorTable, probe) };
    }
    // Accumulate the trailing usage chunk (stream_options.include_usage); it
    // rides the terminal `done` frame.
    const usageObj = parsed.usage;
    if (usageObj !== undefined && usageObj !== null) {
      state.usage = extractChatUsage(usageObj);
    }
    return chunkDeltaFrames(parsed);
  },
};

// --- the dialect --------------------------------------------------------------

/**
 * The baseline OpenAI-compatible dialect (ref `openai`, version `1.0.0`). No
 * media aspect (chat/embeddings text ops carry no media inputs), default
 * transport (bearer + JSON, GET/POST), no task lifecycle (both ops are
 * buffered `direct`/`stream`).
 */
export const openaiDialect: Dialect = {
  ref: 'openai',
  version: '1.0.0',
  operations: {
    'chat.completions': { fetchModes: ['direct', 'stream'] },
    embeddings: { fetchModes: ['direct'] },
  },
  requestMapping,
  credentialInjection,
  responseNormalization,
  errorTable: openaiErrorTable,
};
