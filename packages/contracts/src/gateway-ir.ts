// packages/contracts/src/gateway-ir.ts
//
// model-supply-greenfield 批次0 — the FROZEN gateway IR (design
// docs/plans/draft_2026-07-10_model-supply-greenfield.md §6, pipeline semantics
// §4.1). Five IR objects — GatewayRequest / EffectiveParams / GatewayResponse /
// StreamFrame / TaskUpdate — plus the base vocabulary (operations, paradigms,
// task states, error taxonomy) both the dialect facades and the adapter SPI
// build on.
//
// FREEZE CONTRACT (批次0 只增不改): after this file lands, changes are
// ADDITIVE-ONLY — new optional fields, new enum values, new objects. Never
// rename, remove, retype, or change the meaning of anything here; batch 1
// (db schema) and batch 2 (adapter SPI) interleave against this seam.
//
// Naming: IR container fields are camelCase (the ChatRequest/StreamEvent IR
// convention). Canonical PARAM NAMES living inside `params` records are data,
// not schema fields — they follow the canonical contract's own (snake_case
// wire) vocabulary.
import { z } from 'zod';

// --- operation surface & paradigms (§2.1) ----------------------------------

/**
 * The operation surfaces a model may expose (§2.1 操作面). The external
 * lifecycle shape of a call is declared PER OPERATION on the model
 * (`paradigms` + `slow`); how the upstream delivers is the offering's private
 * `fetch_profile` (§3) — the two are decoupled by the execution planner.
 */
export const OPERATIONS = [
  'chat.completions',
  'embeddings',
  'rerank',
  'moderations',
  'images.generation',
  'images.edit',
  'video.generation',
  'music.generation',
  'tts',
  'asr',
] as const;
export type Operation = (typeof OPERATIONS)[number];
export const operationSchema = z.enum(OPERATIONS);

/**
 * External call paradigms (§2.1). `task` = 202 + Task object. `realtime` is a
 * RESERVED enum slot per §13 (no design, no implementation) — declared now so
 * adding it later never reshapes the frozen vocabulary.
 */
export const PARADIGMS = ['sync', 'stream', 'task', 'realtime'] as const;
export type Paradigm = (typeof PARADIGMS)[number];
export const paradigmSchema = z.enum(PARADIGMS);

// --- task states (§7.1) -----------------------------------------------------

/**
 * The EXTERNAL six-state task machine (§7.1 对外六态; research spec §3.4.3
 * pending/running/succeeded/failed/canceled/expired — the current five-state
 * job machine lacks `expired`). Internal sub-states (upstream_submitted /
 * generating / transferring …) are task-center private (batch 4), never IR.
 * `expired` is PLATFORM-assigned (artifact retention passed, §9.4); adapters
 * normally report only the first five.
 */
export const TASK_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'expired',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusSchema = z.enum(TASK_STATUSES);

/** Terminal task states — no transition may leave them (§7.1; enforced by the task center). */
export const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'canceled', 'expired'] as const;

// --- artifact modes (§9.4, 产物双轨 product ruling) --------------------------

/**
 * Artifact delivery tracks (§9.4): `signed` (default) = signed URL + retention
 * period, `expired` after it lapses; `public` = stable public URL (gallery /
 * asset-library mode), may be exempt from cleanup but keeps checksum +
 * lifecycle records. Defaults live on the model's task defaults + tenant
 * policy; a request-level override rides `GatewayRequestOptions.artifactMode`
 * and is CONSTRAINED by tenant policy.
 */
export const ARTIFACT_MODES = ['signed', 'public'] as const;
export type ArtifactMode = (typeof ARTIFACT_MODES)[number];
export const artifactModeSchema = z.enum(ARTIFACT_MODES);

// --- unified error taxonomy (§6 aspect ⑤, §9.3) -----------------------------

/**
 * The gateway error taxonomy every adapter's per-provider error table maps
 * INTO (§6 aspect ⑤). Design-named members: `unsupported_parameter` (§4 rule 4
 * — all candidates filtered), `model_not_found` (§10 下线语义 404), `conflict`
 * (§5 idempotency same-key-different-body 409), `rate_limited` (§7.8 bounded
 * queue timeout → failed(rate_limited)).
 */
export const GATEWAY_ERROR_CODES = [
  'invalid_input',
  'unsupported_parameter',
  'unauthorized',
  'forbidden',
  'model_not_found',
  'task_not_found',
  'conflict',
  'insufficient_credits',
  'rate_limited',
  'content_filtered',
  'upstream_error',
  'upstream_timeout',
  'task_failed',
  'internal_error',
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/**
 * The normalized gateway error (§9.3 统一信封: adds `failover` and, at the wire
 * layer, `request_id`; 429 carries Retry-After). `retryable` = the SAME hop may
 * be retried; `failover` = routing may try the NEXT candidate offering (§8) —
 * the two flags drive retry/failover independently, both REQUIRED so every
 * adapter error-table row states them explicitly (conformance gate §6 checks
 * completeness). `details` carries structured extras — e.g. for
 * `unsupported_parameter`, WHICH param excluded WHICH offerings (§4 rule 4).
 */
export const gatewayErrorSchema = z.object({
  code: z.enum(GATEWAY_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  failover: z.boolean(),
  /** Upstream provenance: provider slug + the provider's verbatim error code. */
  upstream: z.object({ provider: z.string(), rawCode: z.string().optional() }).optional(),
  /** Backoff hint surfaced as Retry-After on 429 (§9.3). */
  retryAfterMs: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type GatewayError = z.infer<typeof gatewayErrorSchema>;

// --- canonical params on the request (§4.1 layer 1) --------------------------

/**
 * One canonical parameter value as the dialect facade parsed it (§4.1 layer 1
 * canonical 归一). `isDefault: true` = the caller OMITTED the param and this is
 * the canonical contract's default value riding along (设计 "canonical params
 * 带 is_default") — §4 rule 2 makes billing_relevant params filter on this
 * RESOLVED value either way, while rule 3 exempts non-billing defaults from
 * filtering. Layer-1 does NOT apply offering declarations — that is the
 * planner's job (§4.1 layer 2), never the facade's and never the adapter's.
 */
export const canonicalParamValueSchema = z.object({
  value: z.unknown(),
  isDefault: z.boolean(),
});
export type CanonicalParamValue = z.infer<typeof canonicalParamValueSchema>;

// --- media refs (§6 aspect ②) ------------------------------------------------

/** How the CALLER referenced an input medium; upstream delivery form (URL / base64 / file API / bucket) is aspect ②'s dialect-declared choice, not this. */
export const MEDIA_REF_SOURCES = ['url', 'base64', 'file_id'] as const;
export type MediaRefSource = (typeof MEDIA_REF_SOURCES)[number];

/**
 * An input media reference extracted from the request (§6 aspect ② input).
 * `param` names the canonical file/media param this ref belongs to, so the
 * pipeline can resolve `file_id`s / validate against the param's media
 * constraints (§9.4 探测联动) before adapter injection.
 */
export const mediaRefSchema = z.object({
  param: z.string().min(1),
  source: z.enum(MEDIA_REF_SOURCES),
  /** The URL, base64 payload, or file id, per `source`. */
  data: z.string().min(1),
  mime: z.string().optional(),
});
export type MediaRef = z.infer<typeof mediaRefSchema>;

// --- GatewayRequest (§6) ------------------------------------------------------

/**
 * Request-level behavior options. All OPTIONAL — absence = model/tenant
 * defaults. `artifactMode` is the §9.4 request-level override (validated
 * against tenant policy by the planner, never silently honored);
 * `routeTag` is the X-Actionow-Route-Tag narrow-only pin, which per D7 rides
 * the task path with EXACTLY the same semantics as sync.
 */
export const gatewayRequestOptionsSchema = z.object({
  /** Caller asked for the stream paradigm (facades set this from `stream: true` / SSE accept). */
  stream: z.boolean().optional(),
  /** Downstream webhook URL for task updates (§7.6; the webhook SECRET is tenant config, never request-borne). */
  callbackUrl: z.string().url().optional(),
  artifactMode: artifactModeSchema.optional(),
  /** §7.5: persistence failure ⇒ task fails (no charge) instead of degrading to the upstream URL. */
  requirePersist: z.boolean().optional(),
  routeTag: z.string().optional(),
});
export type GatewayRequestOptions = z.infer<typeof gatewayRequestOptionsSchema>;

/**
 * THE gateway request IR (§6) — what a dialect facade emits after §4.1 layer-1
 * canonical 归一, and what the planner routes on. `params` carries EVERY
 * canonical input of the operation (§11: arbitrary workflow inputs ride the
 * canonical contract — chat `messages`, embeddings `input`, image `prompt` are
 * params too, typed by the model's contract), each tagged explicit-vs-default.
 * `idempotency` pairs the caller's key with the request-body fingerprint so
 * the engine can replay same-key-same-body and 409 same-key-DIFFERENT-body
 * (§5); scope is (tenant, key) per §2.6.
 */
export const gatewayRequestSchema = z.object({
  tenantId: z.string().min(1),
  /** The calling api_key id — attribution + (tenant, key) idempotency scope + model-scope whitelist (§2.6). */
  apiKeyId: z.string().min(1),
  /** End-user (subject) attribution dimension, when the caller supplied one (§2.6). */
  subjectId: z.string().optional(),
  operation: operationSchema,
  /** The model's EXTERNAL unique name (§2.1) — routing resolves offerings from it. */
  model: z.string().min(1),
  params: z.record(z.string(), canonicalParamValueSchema).default({}),
  mediaRefs: z.array(mediaRefSchema).default([]),
  options: gatewayRequestOptionsSchema.default({}),
  idempotency: z
    .object({
      key: z.string().min(1),
      /** Fingerprint (hash) of the canonical request body — same key + different fingerprint ⇒ 409 conflict (§5). */
      bodyFingerprint: z.string().min(1),
    })
    .optional(),
});
export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;

// --- EffectiveParams (§4.1 layer 2 output — aspect ①'s REAL input) -----------

/**
 * The planner's post-declaration parameter resolution for the SELECTED
 * offering (§4.1 layer 2): offering declarations applied (domain clamp / map /
 * fixed / operator variants; precedence operator > upstream declaration >
 * canonical default). Carries BOTH sides:
 *
 * - `canonical`: canonical param names → EFFECTIVE canonical values — feeds
 *   pricing tiers (`usage.billingDims`), audit and reconciliation.
 * - `upstream`: UPSTREAM wire names → ACTUAL upstream values (post map/fixed)
 *   — what adapter aspect ① consumes for pure wire-structure placement.
 *
 * Aspect ① consumes `EffectiveParams.upstream` and does STRUCTURE ONLY
 * (query/json/form placement, method, path). It never reads offering
 * declarations and never re-maps values — value/name/domain semantics are
 * fully baked in here (§4.1 layer 3; the "one SPI" precondition). relay_trace
 * and task_events record this object IN FULL (both bags) for audit (§4.1).
 */
export const effectiveParamsSchema = z.object({
  canonical: z.record(z.string(), z.unknown()),
  upstream: z.record(z.string(), z.unknown()),
});
export type EffectiveParams = z.infer<typeof effectiveParamsSchema>;

// --- usage & GatewayResponse (§6, §9.2) ---------------------------------------

/**
 * Billing dimensions (§4.1 字段回流): the billing_relevant params' EFFECTIVE
 * CANONICAL values (resolution / duration tier …) — the price-card tier key
 * and the billing-event snapshot input. Values may be strings ("1080p"),
 * numbers or booleans; sale price tiers key off THESE canonical values while
 * cost keys off the offering's actual values — 双向可见 (§4 rule 2).
 */
export const billingDimsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type BillingDims = z.infer<typeof billingDimsSchema>;

/**
 * Normalized usage on the gateway IR. `metrics` is the metered vector
 * (snake_case dimension keys — input_tokens / output_tokens / audio_seconds /
 * images …) the pricing engine settles on; `billingDims` per above;
 * `estimated: true` marks values NOT reported by the upstream but estimated by
 * the platform (§9.2 补 estimated 标志) — reconciliation treats them separately.
 */
export const gatewayUsageSchema = z.object({
  metrics: z.record(z.string(), z.number()).default({}),
  billingDims: billingDimsSchema.default({}),
  estimated: z.boolean().default(false),
});
export type GatewayUsage = z.infer<typeof gatewayUsageSchema>;

/**
 * Which offering ACTUALLY served the request — echoed on responses so callers
 * and e2e can observe routing (completion criterion 2.2 响应回显实际供给项).
 */
export const servedBySchema = z.object({
  offeringId: z.string(),
  channelId: z.string(),
  /** Provider slug, for display/trace convenience. */
  provider: z.string().optional(),
  /** The upstream model name the offering pinned (offering.upstream_model_name). */
  upstreamModelName: z.string().optional(),
});
export type ServedBy = z.infer<typeof servedBySchema>;

/** A non-fatal warning (§4 rule 4: lenient-mode drops MUST be echoed in warnings[] — never silent). */
export const gatewayWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  /** The canonical param this warning concerns, when param-scoped. */
  param: z.string().optional(),
});
export type GatewayWarning = z.infer<typeof gatewayWarningSchema>;

/**
 * THE gateway response IR (§6) — aspect ⑤'s normalized output, rendered to the
 * client wire by the dialect facade. `output` is the operation-specific
 * normalized payload (chat message / embedding vectors / artifact refs …) —
 * typed per-operation in batch 2+; the envelope freezes now.
 */
export const gatewayResponseSchema = z.object({
  operation: operationSchema,
  /** The REQUESTED external model name (what the caller addressed). */
  model: z.string(),
  output: z.unknown(),
  usage: gatewayUsageSchema,
  servedBy: servedBySchema,
  warnings: z.array(gatewayWarningSchema).default([]),
});
export type GatewayResponse = z.infer<typeof gatewayResponseSchema>;

// --- StreamFrame (§6) ----------------------------------------------------------

/**
 * The normalized stream unit (§6 aspect ⑤ 流转码, bounded buffering). `delta`
 * payloads are operation-specific (chat text/tool-call slices …; typed in
 * batch 2); `usage` may arrive mid-stream or ride the terminal `done`; `error`
 * is a真 error frame (v0.0.9 semantics: an error frame terminates the stream
 * WITHOUT [DONE]). Pre-commit stays: the engine pulls the FIRST upstream frame
 * before answering 200 (§3), so a stream that opens has a live upstream.
 */
export const streamFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delta'), payload: z.unknown() }),
  z.object({ kind: z.literal('usage'), usage: gatewayUsageSchema }),
  z.object({
    kind: z.literal('done'),
    usage: gatewayUsageSchema.optional(),
    servedBy: servedBySchema.optional(),
  }),
  z.object({ kind: z.literal('error'), error: gatewayErrorSchema }),
]);
export type StreamFrame = z.infer<typeof streamFrameSchema>;

// --- TaskUpdate (§6 aspect ⑥) ----------------------------------------------------

/**
 * The normalized upstream task-state observation aspect ⑥ returns from
 * `query` / `parseCallback` (§6 — the envelope contract is EXPLICITLY typed;
 * this replaces the broken bare-body callback chain). The task center folds
 * TaskUpdates into the canonical Task state machine; an UNKNOWN upstream
 * status maps to no transition + alert, never a crash (conformance gate §6),
 * with `rawStatus` preserving the verbatim upstream value for the alert/trace.
 * Adapters report pending/running/succeeded/failed/canceled; `expired` is
 * platform-assigned (§9.4) and never expected from upstream.
 */
export const taskUpdateSchema = z.object({
  /** The upstream's task handle (correlation key for poll/callback/lease takeover). */
  upstreamTaskId: z.string().min(1),
  status: taskStatusSchema,
  /** Upstream verbatim status string, kept for unknown-state alerts and traces. */
  rawStatus: z.string().optional(),
  /** Progress percentage 0–100, when the upstream reports one (§7.1). */
  progress: z.number().min(0).max(100).optional(),
  /** Operation-specific normalized result payload (artifact refs …), present on success. */
  output: z.unknown().optional(),
  usage: gatewayUsageSchema.optional(),
  /** Present when `status: 'failed'` — the normalized failure. */
  error: gatewayErrorSchema.optional(),
  /** Opaque upstream extras worth carrying to the trace (never consumed for control flow). */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
