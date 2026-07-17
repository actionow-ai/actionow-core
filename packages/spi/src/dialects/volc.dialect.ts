// packages/spi/src/dialects/volc.dialect.ts
//
// model-supply-greenfield 批次2 wave2 — the 火山 / 即梦 (Volcengine Visual /
// jimeng) dialect, AUTHORED AS CODE (not DSL). One operation:
// images.generation, fetch mode submit_poll only (CVSync2AsyncSubmitTask →
// CVSync2AsyncGetResult). AK/SK request signing via the SHARED volc-v4 signer
// aspect (signers.ts) — NOT hand-rolled here.
//
// WHY CODE, not a DSL pack (§6 升代码切面 rationale — the signature is NOT the
// reason; it reuses signerCredentialInjection('volc-v4')):
//   1. The poll wire (CVSync2AsyncGetResult) must carry the dynamic `task_id`
//      (+ `req_key`) INSIDE a volc-v4 body-bound *signed* JSON body. The DSL
//      engine's buildQuery only path-substitutes `{task_id}` and carries a
//      STATIC verbatim body — it cannot inject task_id/req_key into the signed
//      body. volc-v4 binds sha256(body), so the poll body differs from the
//      submit body and MUST be re-signed (the pipeline re-runs aspect ③ on
//      every task-path draft, so buildQuery just has to emit the exact body).
//   2. img2img reference images go to DIFFERENT wire keys by delivery form:
//      a URL → `image_urls[]`, raw bytes → `binary_data_base64[]`. The DSL
//      buildMediaInjection is one-path-per-param and cannot branch on form.
//
// RED LINE (§4.1 layer 3): aspect ① is PURE wire-structure porterage — every
// body value comes SOLELY from EffectiveParams.upstream (or upstreamModelName);
// zero value scaling / semantic mapping (width/seed/etc. are already-resolved
// upstream wire values). Deps: spi-internal + @actionow/contracts ONLY.
import type { GatewayError, GatewayUsage, TaskStatus, TaskUpdate } from '@actionow/contracts';
import { gatewayUsageSchema, taskUpdateSchema } from '@actionow/contracts';

import type {
  Dialect,
  DialectContext,
  ErrorTable,
  MediaInjectionAspect,
  NormalizedResponse,
  RequestMappingAspect,
  RequestMappingInput,
  ResponseNormalizationAspect,
  StreamFrameResult,
  SubmitParse,
  TaskLifecycleAspect,
  WireRequestDraft,
  WireResponse,
} from '../aspects.js';
import { resolveError } from '../aspects.js';
import { signerCredentialInjection } from '../signers.js';

// --- wire constants -----------------------------------------------------------

/** The volc Visual gateway host — emit an ABSOLUTE path so the pipeline's pre-③ URL resolve is a no-op and volc-v4 binds the exact host. */
const VOLC_GATEWAY = 'https://visual.volcengineapi.com/';
const VOLC_API_VERSION = '2022-08-31';
const PROVIDER = 'volc';

/** The volc CV standard "success" envelope code; anything else is an in-body business error (§6 aspect ⑤ HTTP-200-carried failure plane). */
const VOLC_SUCCESS_CODE = 10_000;

// --- small typed views over the volc-CV envelope ------------------------------

interface VolcEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: VolcData;
}

interface VolcData {
  task_id?: string;
  status?: string;
  image_urls?: unknown;
  binary_data_base64?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function configString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function usage(images: number): GatewayUsage {
  return gatewayUsageSchema.parse({ metrics: { images } });
}

/** Length of an upstream artifact list (image_urls / binary_data_base64), 0 when absent. */
function listLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

// --- aspect ①: request mapping (submit body) ----------------------------------
//
// The submit body is a PURE structural copy: `req_key` = the offering's
// upstream_model_name (the jimeng model key, e.g. 'jimeng_t2i_v30'), then every
// resolved upstream wire param (prompt / width / height / scale / seed /
// use_pre_llm / ...) copied VERBATIM from EffectiveParams.upstream. No scaling,
// no renaming — the planner already baked those in (§4.1 layer 3).

function buildSubmitDraft(input: RequestMappingInput): WireRequestDraft {
  return {
    method: 'POST',
    path: VOLC_GATEWAY,
    // Action/Version ride draft.query (empty-query absolute path) to mirror the
    // recorded volc-v4 vector; the signer sorts the query so order is
    // signature-irrelevant, and composeWireUrl merges it onto the path.
    query: { Action: 'CVSync2AsyncSubmitTask', Version: VOLC_API_VERSION },
    headers: {},
    bodyKind: 'json',
    body: { req_key: input.upstreamModelName, ...input.params.upstream },
  };
}

const requestMapping: RequestMappingAspect = {
  map: buildSubmitDraft,
};

// --- aspect ②: media injection (img2img reference image) ----------------------
//
// jimeng img2img accepts a reference image in TWO different wire keys depending
// on the resolved delivery form — this is the DSL-inexpressible branch that
// forces code authoring: url → body.image_urls[], base64 → body.binary_data_base64[].
// Bytes are base64-encoded here (no network I/O — the upper-layer resolver
// already fetched them, §6-②). bodyKind stays 'json' so the signer signs the
// exact JSON.stringify(body) the transport will send.

const mediaInjection: MediaInjectionAspect = {
  deliveryForms: ['url', 'base64'],
  inject(draft, media) {
    const body: Record<string, unknown> = { ...asRecord(draft.body) };
    const urls: string[] = [];
    const b64: string[] = [];
    for (const item of media) {
      if (item.form === 'url' && item.url !== undefined) {
        urls.push(item.url);
      } else if (item.form === 'base64' && item.bytes !== undefined) {
        b64.push(Buffer.from(item.bytes).toString('base64'));
      }
    }
    if (urls.length > 0) body.image_urls = urls;
    if (b64.length > 0) body.binary_data_base64 = b64;
    return { ...draft, body };
  },
};

// --- error table (§6 aspect ⑤: per-provider 错误码表 → 统一 taxonomy) ----------
//
// Two failure planes: (A) transport/gateway HTTP status; (B) HTTP-200 with an
// in-body volc-CV code != 10000. The standard HTTP-tier skeleton mirrors the
// reference table (every STANDARD_ERROR_PROBES tier gets an explicit row — gate
// 6 completeness); the volc-v4 signature mismatch surfaces as HTTP 403
// (SignatureDoesNotMatch, usually X-Date skew / wrong service/region — NOT
// same-hop retryable). Business rows match on the in-body `upstreamCode` and are
// declared BEFORE the fallback (first-match-wins = declaration order).
//
// NOTE: the exact numeric business codes below are REPRESENTATIVE of the volc-CV
// moderation / throughput / internal families — reconfirm against the live
// jimeng offering before shipping (the conformance gate keys only off the
// standard HTTP/timeout/network tiers, so it stays self-consistent regardless).

const errorTable: ErrorTable = {
  rows: [
    { match: { httpStatus: 400 }, code: 'invalid_input', retryable: false, failover: false },
    { match: { httpStatus: 401 }, code: 'unauthorized', retryable: false, failover: true },
    { match: { httpStatus: 403 }, code: 'forbidden', retryable: false, failover: true },
    { match: { httpStatus: 404 }, code: 'model_not_found', retryable: false, failover: true },
    { match: { httpStatus: 408 }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
    { match: { httpStatus: [500, 599] }, code: 'upstream_error', retryable: true, failover: true },
    { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
    // --- in-body volc-CV business codes (HTTP 200, envelope code != 10000) ---
    // input/output moderation reject → content_filtered (not retryable, not failover).
    {
      match: { upstreamCode: '50411' },
      code: 'content_filtered',
      retryable: false,
      failover: false,
    },
    {
      match: { upstreamCode: '50412' },
      code: 'content_filtered',
      retryable: false,
      failover: false,
    },
    {
      match: { upstreamCode: '50413' },
      code: 'content_filtered',
      retryable: false,
      failover: false,
    },
    // QPS / throughput exceeded → rate_limited.
    { match: { upstreamCode: '50429' }, code: 'rate_limited', retryable: true, failover: true },
    // upstream internal error → upstream_error.
    { match: { upstreamCode: '50500' }, code: 'upstream_error', retryable: true, failover: true },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: true },
};

// --- aspect ⑤: response normalization -----------------------------------------
//
// `normalize` is only exercised by gate 7 (the sync drive) for this dialect —
// images.generation is submit_poll, so the real result flows through aspect ⑥.
// It still owns the full translation: non-2xx → error table; 2xx + code 10000 →
// ok; 2xx + code != 10000 → the business error plane. `normalizeStreamFrame` is
// interface-required but NEVER driven (no stream capability → gate 4 SKIPs
// legitimately); a safe passthrough stub keeps the interface total.

const responseNormalization: ResponseNormalizationAspect = {
  normalize(res: WireResponse): NormalizedResponse {
    if (!is2xx(res.status)) {
      return {
        ok: false,
        error: resolveError(errorTable, {
          httpStatus: res.status,
          provider: PROVIDER,
          ...(res.text !== undefined ? { message: res.text } : {}),
        }),
      };
    }
    const env = asRecord(res.body) as VolcEnvelope;
    if (env.code !== undefined && env.code !== VOLC_SUCCESS_CODE) {
      return {
        ok: false,
        error: resolveError(errorTable, {
          upstreamCode: String(env.code),
          provider: PROVIDER,
          ...(env.message !== undefined ? { message: env.message } : {}),
        }),
      };
    }
    const data = env.data ?? {};
    const output: unknown = data.image_urls ?? data.binary_data_base64 ?? data;
    return { ok: true, output, usage: usage(listLen(data.image_urls)) };
  },
  normalizeStreamFrame(rawFrame: string): StreamFrameResult {
    // Never reached (images.generation is not stream-capable); kept total for
    // the interface contract.
    return rawFrame === '[DONE]' ? [{ kind: 'done' }] : [{ kind: 'delta', payload: rawFrame }];
  },
};

// --- aspect ⑥: task lifecycle (submit_poll, no callback) ----------------------

const VOLC_STATUS_MAP: Record<string, TaskStatus> = {
  in_queue: 'pending',
  generating: 'running',
  done: 'succeeded',
  not_found: 'failed',
  expired: 'expired',
};

/**
 * The upstream task handle. jimeng's CVSync2AsyncGetResult response does NOT
 * echo the submitted task_id (it carries `request_id`); the task center polls
 * with the id it already holds. For the parse we take the best available
 * correlation id in priority order (a defensively-echoed task_id, else the
 * request_id) so the returned TaskUpdate always carries a non-empty handle.
 */
function extractTaskHandle(env: VolcEnvelope): string {
  const data = env.data ?? {};
  if (typeof data.task_id === 'string' && data.task_id.length > 0) return data.task_id;
  if (typeof env.request_id === 'string' && env.request_id.length > 0) return env.request_id;
  return 'unknown';
}

const taskLifecycle: TaskLifecycleAspect = {
  buildSubmit: buildSubmitDraft,

  parseSubmitResponse(res: WireResponse): SubmitParse {
    const env = asRecord(res.body) as VolcEnvelope;
    if (env.code !== undefined && env.code !== VOLC_SUCCESS_CODE) {
      return {
        error: resolveError(errorTable, {
          upstreamCode: String(env.code),
          provider: PROVIDER,
          ...(env.message !== undefined ? { message: env.message } : {}),
        }),
      };
    }
    const taskId = env.data?.task_id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return {
        error: {
          code: 'upstream_error',
          message: 'volc submit response carried no data.task_id',
          retryable: false,
          failover: false,
        },
      };
    }
    return { upstreamTaskId: taskId };
  },

  // POLL: CVSync2AsyncGetResult. req_key rides the SIGNED body (threaded via
  // ctx.config.req_key — buildQuery gets no upstreamModelName), task_id too; the
  // pipeline re-runs aspect ③ so volc-v4 re-signs this body-bound request. Emit
  // the EXACT body only — deep-freeze after ③ forbids any later mutation.
  buildQuery(upstreamTaskId: string, ctx: DialectContext): WireRequestDraft {
    const reqKey = configString(ctx.config, 'req_key');
    const body: Record<string, unknown> = { task_id: upstreamTaskId };
    if (reqKey !== undefined) body.req_key = reqKey;
    return {
      method: 'POST',
      path: VOLC_GATEWAY,
      query: { Action: 'CVSync2AsyncGetResult', Version: VOLC_API_VERSION },
      headers: {},
      bodyKind: 'json',
      body,
    };
  },

  parseQueryResponse(res: WireResponse): TaskUpdate {
    const env = asRecord(res.body) as VolcEnvelope;
    const data = env.data ?? {};
    const rawStatus = data.status ?? '';
    // §6 未知态不崩: an unmapped upstream status → the last in-flight state
    // ('running') with rawStatus preserved verbatim for the task-center alert.
    const status: TaskStatus = VOLC_STATUS_MAP[rawStatus] ?? 'running';
    const update: TaskUpdate = {
      upstreamTaskId: extractTaskHandle(env),
      status,
      rawStatus,
    };
    if (status === 'succeeded') {
      update.output = data.image_urls ?? data.binary_data_base64 ?? data;
      update.usage = usage(listLen(data.image_urls));
    }
    if (status === 'failed') {
      const error: GatewayError = {
        code: 'task_failed',
        message: env.message ?? `volc task ${rawStatus}`,
        retryable: false,
        failover: false,
      };
      update.error = error;
    }
    return taskUpdateSchema.parse(update);
  },

  // jimeng CVSync2Async is poll-based — there is NO callback channel. The
  // interface requires these members; verify rejects (no callback is authentic)
  // and parse refuses loudly. fetchModes exposes only submit_poll, so the
  // pipeline never drives them.
  verifyCallback(): boolean {
    return false;
  },
  parseCallback(): TaskUpdate {
    throw new Error(
      'volc jimeng images.generation is poll-based (submit_poll); it has no callback channel',
    );
  },
};

// --- credential injection (aspect ③): the SHARED volc-v4 signer ---------------
//
// AK/SK HMAC-SHA256 request signature via the shared signer aspect — NOT
// hand-rolled. Requires an ak_sk CredentialSecret; region = secret.region ??
// ctx.config.region (signer default cn-north-1), service = ctx.config.service
// (MUST be 'cv' for jimeng Visual — the credential-scope service component).
// Body-bound → the poll (different body) is automatically re-signed.
const credentialInjection = signerCredentialInjection('volc-v4');

// --- the dialect aggregate (§6) -----------------------------------------------

export const volcDialect: Dialect = {
  ref: 'volc',
  version: '1.0.0',
  operations: {
    'images.generation': { fetchModes: ['submit_poll'] },
  },
  requestMapping,
  mediaInjection,
  credentialInjection,
  responseNormalization,
  taskLifecycle,
  errorTable,
};
