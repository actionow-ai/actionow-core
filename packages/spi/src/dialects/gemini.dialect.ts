// packages/spi/src/dialects/gemini.dialect.ts
//
// model-supply-greenfield 批次2 wave2 — the GEMINI dialect (Google Generative
// Language `chat.completions`, direct + stream), authored as CODE aspects (not
// DSL) because two hard blockers put it outside the DSL request builder /
// stream normalizer (design docs/plans/draft_2026-07-10 §6, §4.1):
//
//   1. The upstream PATH + VERB switch on the stream flag —
//      POST models/{model}:generateContent          (direct)
//      POST models/{model}:streamGenerateContent?alt=sse  (stream)
//      — but the DSL request builder never reads `input.stream`, so it cannot
//      branch. Aspect ① here reads it (§ code-mode driver).
//   2. Streaming needs STRUCTURED delta extraction from
//      candidates[0].content.parts[].text inside a full GenerateContentResponse
//      JSON per `data:` frame; the DSL normalizeStreamFrame only forwards the
//      raw `data:` payload verbatim, so it cannot reach parts[].text.
//
// Auth = `?key=<api_key>` query scheme (no signer). Model rides the URL PATH,
// never the body. Aspect ① is pure wire-structure porterage: body = spread of
// `params.upstream` (already gemini-wire-shaped by the planner, §4.1 layer 2);
// it NEVER reads `params.canonical` and scales no value (§4.1 layer-3 red line).
import type {
  CredentialSecret,
  GatewayError,
  GatewayUsage,
  StreamFrame,
} from '@actionow/contracts';

import type {
  CredentialInjectionAspect,
  Dialect,
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

const PROVIDER = 'gemini';

// --- small structural helpers (all inputs are `unknown` wire bodies) ----------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mkUsage(metrics: Record<string, number>): GatewayUsage {
  return { metrics, billingDims: {}, estimated: false };
}

/**
 * Extract the additive usage vector from a GenerateContentResponse's
 * `usageMetadata` (§9.2). Absent breakdown keys are LEFT UNSET so the metric
 * vector stays additive across mid-stream chunks (latest-wins).
 */
function extractUsage(usageMetadata: unknown): GatewayUsage {
  const um = asRecord(usageMetadata);
  const metrics: Record<string, number> = {};
  const input = num(um.promptTokenCount);
  const output = num(um.candidatesTokenCount);
  const reasoning = num(um.thoughtsTokenCount);
  const cached = num(um.cachedContentTokenCount);
  if (input !== undefined) metrics.input_tokens = input;
  if (output !== undefined) metrics.output_tokens = output;
  if (reasoning !== undefined) metrics.reasoning_tokens = reasoning;
  if (cached !== undefined) metrics.cached_input_tokens = cached;
  return mkUsage(metrics);
}

/** A post-generation content block on an otherwise-200 response → content_filtered (§6-⑤ 200 业务错). */
function contentFilteredError(reason: string): GatewayError {
  return {
    code: 'content_filtered',
    message: `gemini blocked the response (${reason})`,
    retryable: false,
    failover: false,
    upstream: { provider: PROVIDER, rawCode: reason },
  };
}

// --- error table (§6-⑤ gemini status → unified taxonomy) ----------------------

/**
 * The gemini error table. Rows are first-match-wins; the `fallback` makes it
 * total by construction so `resolveError` never fails. The special
 * `API_KEY_INVALID` row sits ABOVE the plain 400 row so an invalid key (which
 * gemini surfaces as HTTP 400 status API_KEY_INVALID, not 401) is classified as
 * auth; a bare 400 still lands on invalid_input. Flags produce ZERO gate-6 soft
 * warnings (4xx client errors non-retryable; 5xx failover; timeout/network
 * retryable).
 */
export const geminiErrorTable: ErrorTable = {
  rows: [
    // Invalid API key comes back as HTTP 400 with status API_KEY_INVALID.
    {
      match: { httpStatus: 400, upstreamCode: 'API_KEY_INVALID' },
      code: 'unauthorized',
      retryable: false,
      failover: true,
    },
    // 400 INVALID_ARGUMENT / FAILED_PRECONDITION.
    { match: { httpStatus: 400 }, code: 'invalid_input', retryable: false, failover: false },
    // 401 UNAUTHENTICATED.
    { match: { httpStatus: 401 }, code: 'unauthorized', retryable: false, failover: true },
    // 403 PERMISSION_DENIED.
    { match: { httpStatus: 403 }, code: 'forbidden', retryable: false, failover: true },
    // 404 NOT_FOUND (model retired / unknown).
    { match: { httpStatus: 404 }, code: 'model_not_found', retryable: false, failover: true },
    // 408 request timeout.
    { match: { httpStatus: 408 }, code: 'upstream_timeout', retryable: true, failover: true },
    // 429 RESOURCE_EXHAUSTED (rate / quota).
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
    // 5xx: INTERNAL 500 / UNAVAILABLE 503 / DEADLINE_EXCEEDED 504.
    { match: { httpStatus: [500, 599] }, code: 'upstream_error', retryable: true, failover: true },
    // Transport-level failures (no HTTP response).
    { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: true },
};

/** Build the error probe for a non-2xx GenerateContentResponse: `error.status` → upstreamCode, `error.message` → message. */
function httpErrorProbe(res: WireResponse): ErrorProbe {
  const err = asRecord(asRecord(res.body).error);
  const probe: ErrorProbe = { httpStatus: res.status, provider: PROVIDER };
  const status = str(err.status);
  if (status !== undefined) probe.upstreamCode = status;
  const message = str(err.message) ?? res.text;
  if (message !== undefined) probe.message = message;
  return probe;
}

// --- aspect ①: request mapping (path+verb branch on stream) -------------------

/**
 * Aspect ① — the CODE-mode driver. Model → URL PATH (never the body); the verb
 * (`:generateContent` vs `:streamGenerateContent`) and the `alt=sse` query
 * branch on `input.stream`. Body = spread of `params.upstream` ONLY (already
 * gemini-wire-shaped: contents / systemInstruction / generationConfig / tools /
 * toolConfig / safetySettings …). Reads `params.canonical` NEVER (§4.1 red line).
 */
const requestMapping: RequestMappingAspect = {
  map(input: RequestMappingInput): WireRequestDraft {
    const verb = input.stream ? 'streamGenerateContent' : 'generateContent';
    const draft: WireRequestDraft = {
      method: 'POST',
      path: `models/${input.upstreamModelName}:${verb}`,
      bodyKind: 'json',
      body: { ...input.params.upstream },
    };
    if (input.stream) draft.query = { alt: 'sse' };
    return draft;
  },
};

// --- aspect ③: credential injection (query ?key=) -----------------------------

function apiKeyOf(secret: CredentialSecret): string {
  if (secret.scheme === 'query' || secret.scheme === 'bearer' || secret.scheme === 'x_api_key') {
    return secret.api_key;
  }
  throw new TypeError(
    `gemini requires a query/bearer api-key credential, got scheme "${secret.scheme}"`,
  );
}

/**
 * Aspect ③ — merge `key=<api_key>` into the query bag (alongside any existing
 * `alt=sse` on the stream path). composeWireUrl (aspects.ts) URL-encodes via
 * searchParams.set, so DO NOT pre-encodeURIComponent (the legacy adapter
 * double-encodes; the SPI must not). NOTE: a query key leaks into the URL — a
 * faithful alternative is the `x-goog-api-key` header, but the working adapter
 * uses `?key=`, so we match query to stay 1:1.
 */
const credentialInjection: CredentialInjectionAspect = {
  injectCredential(draft, secret): WireRequestDraft {
    return {
      ...draft,
      query: { ...(draft.query ?? {}), key: apiKeyOf(secret) },
    };
  },
};

// --- aspect ⑤: response normalization -----------------------------------------

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Concatenate all `text` parts and collect `functionCall` parts from a candidate's content. */
function extractParts(candidate: Record<string, unknown>): {
  text: string;
  toolCalls: { id: string; name: string; args: unknown }[];
} {
  const parts = asArray(asRecord(candidate.content).parts);
  let text = '';
  const toolCalls: { id: string; name: string; args: unknown }[] = [];
  for (const raw of parts) {
    const part = asRecord(raw);
    const t = str(part.text);
    if (t !== undefined) text += t;
    if (part.functionCall !== undefined) {
      const fc = asRecord(part.functionCall);
      const name = str(fc.name) ?? 'function';
      // gemini carries NO tool-call id → synthesize a stable name-based id.
      toolCalls.push({ id: `call_${name}`, name, args: fc.args });
    }
  }
  return { text, toolCalls };
}

const responseNormalization: ResponseNormalizationAspect = {
  normalize(res: WireResponse): NormalizedResponse {
    if (!is2xx(res.status)) {
      return { ok: false, error: resolveError(geminiErrorTable, httpErrorProbe(res)) };
    }
    const body = asRecord(res.body);

    // 200-carried business error: a prompt-level block, or a post-generation
    // SAFETY/RECITATION finish, is a content filter — never a bare success.
    const blockReason = str(asRecord(body.promptFeedback).blockReason);
    if (blockReason !== undefined) {
      return { ok: false, error: contentFilteredError(blockReason) };
    }
    const first = asRecord(asArray(body.candidates)[0]);
    const finishReason = str(first.finishReason);
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      return { ok: false, error: contentFilteredError(finishReason) };
    }

    const { text, toolCalls } = extractParts(first);
    const output: Record<string, unknown> = { text };
    if (toolCalls.length > 0) output.toolCalls = toolCalls;
    if (finishReason !== undefined) output.finishReason = finishReason;
    return { ok: true, output, usage: extractUsage(body.usageMetadata) };
  },

  normalizeStreamFrame(rawFrame: string, state: StreamNormalizationState): StreamFrameResult {
    // gemini has NO real [DONE] sentinel (the stream ends on connection close);
    // the conformance harness force-appends one, so treat a literal [DONE] as a
    // terminal done — a safety net that also drives the gate's done branch.
    if (rawFrame.trim() === '[DONE]') {
      return [terminalDone(state)];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFrame) as unknown;
    } catch {
      return {
        error: {
          code: 'upstream_error',
          message: 'gemini stream frame was not valid JSON',
          retryable: false,
          failover: false,
        },
      };
    }

    const body = asRecord(parsed);

    // A stream-carried error object → terminal error via the table.
    if (body.error !== undefined) {
      const err = asRecord(body.error);
      const probe: ErrorProbe = { provider: PROVIDER };
      const code = num(err.code);
      if (code !== undefined) probe.httpStatus = code;
      const status = str(err.status);
      if (status !== undefined) probe.upstreamCode = status;
      const message = str(err.message);
      if (message !== undefined) probe.message = message;
      return { error: resolveError(geminiErrorTable, probe) };
    }

    const first = asRecord(asArray(body.candidates)[0]);

    // Business content filter mid-stream → terminal error.
    const blockReason = str(asRecord(body.promptFeedback).blockReason);
    if (blockReason !== undefined) return { error: contentFilteredError(blockReason) };
    const finishReason = str(first.finishReason);
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      return { error: contentFilteredError(finishReason) };
    }

    const frames: StreamFrame[] = [];
    const { text, toolCalls } = extractParts(first);
    // functionCall parts stream WHOLE per chunk (no OpenAI-style fragmentation).
    for (const call of toolCalls) {
      frames.push({
        kind: 'delta',
        payload: { functionCall: { name: call.name, args: call.args } },
      });
    }
    if (text.length > 0) frames.push({ kind: 'delta', payload: text });

    // usageMetadata rides one or more chunks (usually the last) — latest-wins.
    if (body.usageMetadata !== undefined) {
      const usage = extractUsage(body.usageMetadata);
      state.usage = usage;
      frames.push({ kind: 'usage', usage });
    }

    // A finishReason present marks the production done trigger.
    if (finishReason !== undefined) frames.push(terminalDone(state));
    return frames;
  },
};

/** Build the terminal `done` frame, attaching the latest stashed usage if any. */
function terminalDone(state: StreamNormalizationState): StreamFrame {
  const usage = state.usage;
  return usage === undefined ? { kind: 'done' } : { kind: 'done', usage: usage as GatewayUsage };
}

// --- dialect aggregate --------------------------------------------------------

/**
 * The gemini dialect (ref `gemini`, version `1.0.0`). chat.completions supports
 * `direct` + `stream` only — no submit_poll/submit_callback, so no
 * TaskLifecycleAspect; media rides inline inside `contents[].parts[]`
 * (inlineData/fileData, baked into params.upstream by the planner), so no
 * MediaInjectionAspect. Both are correct architecture, not fake-pass skips.
 */
export const geminiDialect: Dialect = {
  ref: 'gemini',
  version: '1.0.0',
  operations: {
    'chat.completions': { fetchModes: ['direct', 'stream'] },
  },
  requestMapping,
  credentialInjection,
  responseNormalization,
  errorTable: geminiErrorTable,
};
