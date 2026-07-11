// packages/spi/src/aspects.ts
//
// model-supply-greenfield 批次2 slice 1 — the SIX-ASPECT adapter SPI (design
// docs/plans/draft_2026-07-10_model-supply-greenfield.md §6; hard principle #3:
// ONE adapter SPI, two authoring modes, kill the three-track coexistence).
//
// A dialect implements these aspect interfaces (in code, or generated from the
// batch-2 DSL); the execution pipeline (pipeline.ts) composes them in the fixed
// order ① request mapping → ② media injection → ③ credential injection →
// ④ transport → ⑤ response normalization, with ⑥ task lifecycle for the
// submit/poll/callback paths. Everything here is STATELESS pure structure —
// the "one SPI" precondition (§4.1): aspects never read offering declarations.
import type {
  CredentialSecret,
  EffectiveParams,
  FetchMode,
  GatewayError,
  GatewayErrorCode,
  GatewayUsage,
  HttpClient,
  Operation,
  StreamFrame,
  TaskUpdate,
} from '@actionow/contracts';

// --- shared dialect context ---------------------------------------------------

/**
 * The per-call context every aspect receives (§6). Carries the CHANNEL-scoped
 * environment — never request params, never offering declarations:
 *
 * - `baseUrl`: the channel's upstream base URL (channel.base_url, §2.3);
 *   absent → the dialect's built-in default, if it hardcodes absolute paths.
 * - `config`: opaque dialect configuration (e.g. AK/SK signing `service` /
 *   `region`, provider callback-verification template §2.2). Shape is
 *   dialect-defined.
 * - `nowMs`: injected clock (unix ms) so signing / JWT minting is
 *   deterministic in tests (same discipline as the legacy signer layer).
 */
export interface DialectContext {
  baseUrl?: string;
  config?: Record<string, unknown>;
  nowMs: number;
}

// --- wire request draft (aspects ①–③ currency) --------------------------------

/** HTTP methods a wire draft may declare. NOTE: the default transport can only carry GET/POST (the frozen HttpClient contract); other verbs need a custom {@link TransportAspect}. */
export const WIRE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type WireMethod = (typeof WIRE_METHODS)[number];

/** How the draft's `body` is to be serialized on the wire. */
export const WIRE_BODY_KINDS = ['json', 'form', 'multipart', 'none'] as const;
export type WireBodyKind = (typeof WIRE_BODY_KINDS)[number];

/**
 * The under-construction upstream request — the currency flowing ① → ② → ③
 * (§6). Pure WIRE STRUCTURE: field placement (query / json / form / path),
 * method, path — no value semantics (those were baked into
 * `EffectiveParams.upstream` by the planner, §4.1 layer 2).
 *
 * `path` starts channel-relative (resolved against `DialectContext.baseUrl` by
 * the pipeline before aspect ③) or absolute; by aspect ③/④ time it is always
 * an ABSOLUTE URL (signers need the host). `query` rides separately so signers
 * can canonicalize it. After aspect ③ the pipeline DEEP-FREEZES the draft —
 * any later mutation throws (§6 凭证注入后请求冻结).
 */
export interface WireRequestDraft {
  method: WireMethod;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyKind: WireBodyKind;
  body?: unknown;
}

/**
 * The draft after aspect ③ — credential injected, deep-frozen at runtime
 * (`Object.freeze`, recursively). The pipeline GUARANTEES ③ is the last
 * construction step; transport (④) sends it verbatim.
 */
export type FrozenWireRequest = Readonly<WireRequestDraft>;

/**
 * Compose the absolute request URL from a draft's `path` + `query`. Requires
 * `path` to already be absolute (the pipeline resolves relative paths against
 * `ctx.baseUrl` BEFORE aspect ③, so signers and transport derive the SAME
 * URL). `query` entries are set on top of any query string already in `path`.
 */
export function composeWireUrl(req: Pick<WireRequestDraft, 'path' | 'query'>): string {
  let url: URL;
  try {
    url = new URL(req.path);
  } catch {
    throw new TypeError(
      `wire request path must be an absolute URL by aspect ③/④ time (the pipeline resolves it against ctx.baseUrl); got "${req.path}"`,
    );
  }
  for (const [key, value] of Object.entries(req.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// --- aspect ①: request mapping (§6-①, §4.1 layer 3) ----------------------------

/**
 * Aspect ①'s input. THE §4.1 layer-3 red line is enforced by this TYPE: the
 * only parameter bag it carries is {@link EffectiveParams} (the planner's
 * post-declaration output) — offering declarations / param declarations /
 * `GatewayRequest.params` (layer-1 canonical values) are structurally
 * unrepresentable here, so an adapter CANNOT re-map values or read supply
 * config even by mistake. Aspect ① consumes `params.upstream` (upstream wire
 * names → actual upstream values); `params.canonical` rides along solely
 * because EffectiveParams is one frozen object (billing/audit use it upstream
 * of the SPI — dialects have no business reading it).
 */
export interface RequestMappingInput {
  operation: Operation;
  /** offering.upstream_model_name — what the upstream calls this model (§2.5). */
  upstreamModelName: string;
  /** §4.1 layer-2 output; aspect ① consumes `.upstream` and does STRUCTURE ONLY. */
  params: EffectiveParams;
  /** Upstream stream framing requested (fetch_profile mode `stream`, §3). */
  stream: boolean;
  ctx: DialectContext;
}

/**
 * ① 请求映射 (§6-①): IR → dialect wire request. A PURE FUNCTION doing pure
 * wire-structure porterage — where each upstream param sits (query / json body
 * / form / path), which method, which path. It performs NO value-domain
 * scaling and NO semantic mapping (§4.1 layer 3: those are already baked into
 * `EffectiveParams.upstream` by the planner — the adapter never re-maps).
 */
export interface RequestMappingAspect {
  map(input: RequestMappingInput): WireRequestDraft;
}

// --- aspect ②: media injection (§6-②) ------------------------------------------

/** Upstream media delivery forms a dialect can accept (§6-②, declared per dialect). */
export const MEDIA_DELIVERY_FORMS = ['url', 'base64', 'file_api', 'bucket'] as const;
export type MediaDeliveryForm = (typeof MEDIA_DELIVERY_FORMS)[number];

/**
 * One RESOLVED media input handed to aspect ② for placement. The upper-layer
 * resolver has already done ALL I/O — fetching bytes (SSRF-guarded, §9.4),
 * uploading via a provider file API, or staging in a bucket — and reduced the
 * medium to a placeable form: a `url` string or raw `bytes`. The aspect only
 * PLACES it into the draft (§6-②: 字节取回/file_api 上传的 I/O 由上层 resolver
 * 完成,切面只做放置). `param` names the upstream wire param this medium
 * belongs to.
 */
export interface ResolvedMediaInput {
  param: string;
  form: 'url' | 'base64';
  url?: string;
  bytes?: Uint8Array;
  mime?: string;
}

/**
 * ② 媒体注入 (§6-②): the dialect declares which delivery forms its upstream
 * accepts (`deliveryForms` — consumed by the upper-layer resolver to pick a
 * target form) and places resolved media into the wire draft. May be async
 * (base64 encoding of large buffers etc.) but must do NO network I/O.
 */
export interface MediaInjectionAspect {
  /** Delivery forms the upstream accepts, in preference order (§6-②: URL / base64 / 官方文件接口 / 直传桶). */
  deliveryForms: readonly MediaDeliveryForm[];
  inject(
    draft: WireRequestDraft,
    media: ResolvedMediaInput[],
    ctx: DialectContext,
  ): WireRequestDraft | Promise<WireRequestDraft>;
}

// --- aspect ③: credential injection (§6-③) --------------------------------------

/**
 * ③ 凭证注入 (§6-③): decorate the draft with authentication material —
 * headers (bearer / x-api-key), query keys, or a full request signature
 * (AK/SK dialects call the shared signer aspect, signers.ts). The PIPELINE
 * GUARANTEES this is the LAST construction step: its output is deep-frozen and
 * any later mutation throws (产出即冻结). Signature-class dialects therefore
 * sign the FINAL bytes-to-be — nothing may change after.
 *
 * `secret` is the channel credential's structured secret (shape fixed by the
 * channel's auth scheme, §2.3); it exists ONLY inside this aspect's frame —
 * never on the draft as structured material, never in logs.
 */
export interface CredentialInjectionAspect {
  injectCredential(
    draft: WireRequestDraft,
    secret: CredentialSecret,
    ctx: DialectContext,
  ): WireRequestDraft;
}

// --- aspect ④: transport (§6-④) --------------------------------------------------

/**
 * The four-timeout budget (§6-④; vocabulary = fault_policy's four timeouts).
 * Mapped onto {@link HttpClient} request fields by `applyTimeoutBudget`
 * (pipeline.ts), with the SAME field semantics as the legacy engine mapping:
 * `totalTimeoutMs` → `timeoutMs`, `connectTimeoutMs` → `connectTimeoutMs`,
 * `ttftTimeoutMs` → `firstChunkTimeoutMs`, `idleTimeoutMs` → `idleTimeoutMs`.
 */
export interface TimeoutBudget {
  connectTimeoutMs?: number;
  ttftTimeoutMs?: number;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * A completed (buffered) upstream HTTP exchange as aspect ⑤ sees it.
 * `headers` is best-effort: the default transport cannot surface response
 * headers (the frozen HttpClient contract omits them) and passes `{}`; a
 * custom {@link TransportAspect} may fill it. `text` is the raw body text when
 * the transport had it (JSON parse fallback / error bodies).
 */
export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text?: string;
}

/** A streaming upstream exchange: decoded UTF-8 text chunks (NOT lines — chunks may split lines arbitrarily; the pipeline's bounded SSE framer does the framing). */
export interface WireStreamResponse {
  status: number;
  lines: AsyncIterable<string>;
}

/**
 * ④ 传输 (§6-④): HTTP/SSE + proxy + four timeouts. A DEFAULT implementation is
 * provided by the pipeline (`defaultTransport`) — dialects are NOT required to
 * implement this aspect and normally should not; override only for transports
 * the default cannot express (multipart uploads, non-GET/POST verbs, private
 * framing). Implementations MUST send the frozen request verbatim and never
 * mutate it.
 */
export interface TransportAspect {
  request(
    req: FrozenWireRequest,
    http: HttpClient,
    budget: TimeoutBudget,
    proxyUrl?: string,
  ): Promise<WireResponse>;
  stream(
    req: FrozenWireRequest,
    http: HttpClient,
    budget: TimeoutBudget,
    proxyUrl?: string,
  ): Promise<WireStreamResponse>;
}

// --- aspect ⑤: response normalization (§6-⑤) --------------------------------------

/**
 * Aspect ⑤'s discriminated result (§6-⑤): a 200 carrying a BUSINESS error is
 * translated HERE — `ok: false` with the table-resolved {@link GatewayError} —
 * so "HTTP success" never leaks upstream failure into billing/settle.
 */
export type NormalizedResponse =
  | { ok: true; output: unknown; usage: GatewayUsage }
  | { ok: false; error: GatewayError };

/**
 * Per-stream scratch state for `normalizeStreamFrame`. The pipeline creates
 * one EMPTY object per stream and passes the SAME object to every frame call —
 * dialects accumulate whatever they need (running usage, tool-call assembly …)
 * without owning module state (aspects stay stateless across calls).
 */
export type StreamNormalizationState = Record<string, unknown>;

/**
 * `normalizeStreamFrame`'s per-frame verdict: zero or more normalized
 * {@link StreamFrame}s to emit (an empty array = administrative frame,
 * nothing to forward), or `{ error }` = protocol violation — the pipeline
 * emits ONE terminal `error` frame and stops consuming the upstream.
 */
export type StreamFrameResult = StreamFrame[] | { error: GatewayError };

/**
 * ⑤ 响应归一 (§6-⑤): upstream wire → gateway IR.
 *
 * - `normalize` receives EVERY completed buffered exchange — including
 *   non-2xx statuses — and translates: success → `{ok, output, usage}` (usage
 *   extraction §9.2); HTTP errors AND 200-carried business errors → the
 *   unified taxonomy via the dialect's {@link ErrorTable} (`resolveError`).
 * - `normalizeStreamFrame` is called once per SSE event (the pipeline's
 *   BOUNDED framer already assembled it; `rawFrame` is the event's joined
 *   `data:` payload — heartbeat comments never reach the dialect, and the
 *   `[DONE]` sentinel is passed through verbatim). Emitting a terminal frame
 *   (`done` / `error`) ends the stream.
 */
export interface ResponseNormalizationAspect {
  normalize(res: WireResponse, ctx: DialectContext): NormalizedResponse;
  normalizeStreamFrame(rawFrame: string, state: StreamNormalizationState): StreamFrameResult;
}

// --- aspect ⑥: task lifecycle (§6-⑥) ------------------------------------------------

/**
 * An inbound upstream callback, verbatim (§6-⑥). `rawBody` is the EXACT body
 * text as received (signature verification must run over raw bytes, never a
 * re-serialization); header names are lower-cased by the receiving edge.
 */
export interface RawCallback {
  rawBody: string;
  headers: Record<string, string>;
}

/**
 * `parseSubmitResponse`'s verdict: the upstream accepted and returned a task
 * handle (`upstreamTaskId` — the §7 correlation key for poll / callback /
 * lease takeover), OR answered inline with the finished result (some
 * "task" APIs complete synchronously under load thresholds), OR a 2xx-carried
 * business rejection translated to the unified taxonomy.
 */
export type SubmitParse =
  | { upstreamTaskId: string }
  | { inline: { output: unknown; usage: GatewayUsage } }
  | { error: GatewayError };

/**
 * ⑥ 任务生命周期 (§6-⑥): submit / query / cancel / callback for the
 * `submit_poll` / `submit_callback` fetch modes (§3). The envelope contract is
 * EXPLICITLY TYPED — every parse returns the frozen {@link TaskUpdate} IR
 * (this is the fix for the legacy bare-body callback chain break).
 *
 * Parse rules (conformance gate §6): an UNKNOWN upstream status must map to a
 * legal `TaskUpdate.status` (dialect's judgment — typically the last known
 * in-flight state) with `rawStatus` carrying the verbatim upstream value so
 * the task center can alert without crashing. Build methods produce drafts
 * that then flow ③ credential injection → ④ transport in the pipeline.
 * `verifyCallback` runs BEFORE `parseCallback` — an unverified callback is
 * never parsed (§3 submit_callback: 验签→去重→乱序容忍→反查确认 starts here).
 */
export interface TaskLifecycleAspect {
  /** Build the task-creation request. Reuses aspect ①'s input shape (§6-⑥ 复用①的输入形状). */
  buildSubmit(input: RequestMappingInput): WireRequestDraft;
  parseSubmitResponse(res: WireResponse): SubmitParse;
  buildQuery(upstreamTaskId: string, ctx: DialectContext): WireRequestDraft;
  parseQueryResponse(res: WireResponse): TaskUpdate;
  /** Optional — absent ⇒ upstream cannot cancel; the task center falls back to local-mark + late-result-discard (§7.7). */
  buildCancel?(upstreamTaskId: string, ctx: DialectContext): WireRequestDraft;
  parseCancelResponse?(res: WireResponse): TaskUpdate;
  /**
   * Verify an inbound callback's authenticity over the RAW body + headers
   * using the channel credential and/or the provider's callback-verification
   * template (`ctx.config`, §2.2). `false` ⇒ the pipeline REJECTS without
   * parsing. `secret` may be undefined (providers whose callbacks are
   * verified by template material only).
   */
  verifyCallback(
    raw: RawCallback,
    secret: CredentialSecret | undefined,
    ctx: DialectContext,
  ): boolean;
  parseCallback(raw: RawCallback): TaskUpdate;
}

// --- error table (§6-⑤ per-provider 错误码表 → 统一 taxonomy) ------------------------

/** Probe kinds: `http` = a completed exchange (status/code/message); `timeout` / `network` = transport-level failures with no HTTP response (§6 一致性门: 超时/网络错也必须可归类). */
export const ERROR_PROBE_KINDS = ['http', 'timeout', 'network'] as const;
export type ErrorProbeKind = (typeof ERROR_PROBE_KINDS)[number];

/**
 * One row's match conditions — AND semantics over the SPECIFIED fields; an
 * empty match `{}` is a catch-all. `httpStatus` is an exact status or an
 * INCLUSIVE `[lo, hi]` range; `upstreamCode` matches the provider's verbatim
 * error code exactly; `messageIncludes` is a case-insensitive substring;
 * `kind` pins the row to a probe kind (unspecified = any kind — `httpStatus`
 * rows implicitly never match timeout/network probes, which carry no status).
 */
export interface ErrorTableMatch {
  httpStatus?: number | readonly [number, number];
  upstreamCode?: string;
  messageIncludes?: string;
  kind?: ErrorProbeKind;
}

/** The classification a row (or the fallback) assigns: unified code + the two INDEPENDENT §9.3 flags (`retryable` = same hop may retry; `failover` = routing may try the next offering). */
export interface ErrorDisposition {
  code: GatewayErrorCode;
  retryable: boolean;
  failover: boolean;
}

/** One error-table row: first matching row wins (declaration order = priority). */
export interface ErrorTableRow extends ErrorDisposition {
  match: ErrorTableMatch;
}

/**
 * The dialect's per-provider error table (§6-⑤). `fallback` is REQUIRED —
 * the table is total by construction, so `resolveError` can never fail to
 * classify; `errorTableCompleteness` then reports which STANDARD probes only
 * reach the fallback (the conformance gate asserts none do).
 */
export interface ErrorTable {
  rows: readonly ErrorTableRow[];
  fallback: ErrorDisposition;
}

/**
 * What the pipeline (or a dialect's `normalize`) knows about a failure when it
 * consults the table. `kind` defaults to `http`. `retryAfterMs` (parsed from
 * Retry-After on 429s) and `provider` ride through onto the resulting
 * {@link GatewayError} (§9.3 统一信封).
 */
export interface ErrorProbe {
  kind?: ErrorProbeKind;
  httpStatus?: number;
  upstreamCode?: string;
  message?: string;
  provider?: string;
  retryAfterMs?: number;
}

function rowMatches(match: ErrorTableMatch, probe: ErrorProbe, kind: ErrorProbeKind): boolean {
  if (match.kind !== undefined && match.kind !== kind) return false;
  if (match.httpStatus !== undefined) {
    if (probe.httpStatus === undefined) return false;
    if (typeof match.httpStatus === 'number') {
      if (probe.httpStatus !== match.httpStatus) return false;
    } else {
      const [lo, hi] = match.httpStatus;
      if (probe.httpStatus < lo || probe.httpStatus > hi) return false;
    }
  }
  if (match.upstreamCode !== undefined && probe.upstreamCode !== match.upstreamCode) return false;
  if (match.messageIncludes !== undefined) {
    if (probe.message === undefined) return false;
    if (!probe.message.toLowerCase().includes(match.messageIncludes.toLowerCase())) return false;
  }
  return true;
}

/** Index of the first matching row, or -1 (→ fallback). Shared by {@link resolveError} and {@link errorTableCompleteness} so the two can never disagree. */
function findRowIndex(table: ErrorTable, probe: ErrorProbe): number {
  const kind = probe.kind ?? 'http';
  for (let i = 0; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    if (row !== undefined && rowMatches(row.match, probe, kind)) return i;
  }
  return -1;
}

/**
 * Classify a failure via the dialect's error table (§6-⑤): first matching row
 * wins, else the mandatory fallback — total by construction. Produces the
 * frozen {@link GatewayError} envelope with upstream provenance and the
 * Retry-After hint carried through (§9.3).
 */
export function resolveError(table: ErrorTable, probe: ErrorProbe): GatewayError {
  const index = findRowIndex(table, probe);
  const hit: ErrorDisposition =
    index === -1 ? table.fallback : (table.rows[index] ?? table.fallback);
  const kind = probe.kind ?? 'http';
  const message =
    probe.message ??
    (kind === 'http'
      ? `upstream HTTP error${probe.httpStatus === undefined ? '' : ` ${String(probe.httpStatus)}`}`
      : `upstream ${kind} error`);
  const error: GatewayError = {
    code: hit.code,
    message,
    retryable: hit.retryable,
    failover: hit.failover,
  };
  if (probe.provider !== undefined) {
    error.upstream =
      probe.upstreamCode === undefined
        ? { provider: probe.provider }
        : { provider: probe.provider, rawCode: probe.upstreamCode };
  }
  if (probe.retryAfterMs !== undefined) error.retryAfterMs = probe.retryAfterMs;
  return error;
}

/**
 * The standard probe set the conformance gate (batch-2 slice 3) asserts
 * explicit coverage for (§6 一致性测试门: 错误码表完整性 — 常见 HTTP 档位
 * 400/401/403/404/408/429/5xx 与超时/网络错都落到确定行).
 */
export const STANDARD_ERROR_PROBES: readonly { label: string; probe: ErrorProbe }[] = [
  { label: 'http:400', probe: { httpStatus: 400 } },
  { label: 'http:401', probe: { httpStatus: 401 } },
  { label: 'http:403', probe: { httpStatus: 403 } },
  { label: 'http:404', probe: { httpStatus: 404 } },
  { label: 'http:408', probe: { httpStatus: 408 } },
  { label: 'http:429', probe: { httpStatus: 429 } },
  { label: 'http:500', probe: { httpStatus: 500 } },
  { label: 'http:502', probe: { httpStatus: 502 } },
  { label: 'http:503', probe: { httpStatus: 503 } },
  { label: 'http:504', probe: { httpStatus: 504 } },
  { label: 'timeout', probe: { kind: 'timeout' } },
  { label: 'network', probe: { kind: 'network' } },
];

/** One standard probe's resolution: which disposition it reached, via an explicit row (`rowIndex`) or the fallback. */
export interface ErrorTableCoverageEntry {
  probe: string;
  code: GatewayErrorCode;
  retryable: boolean;
  failover: boolean;
  via: 'row' | 'fallback';
  rowIndex?: number;
}

/** The completeness report (§6 一致性门 input). `missing` lists standard probes that only reach the fallback; `complete` = none do. */
export interface ErrorTableCompletenessReport {
  entries: ErrorTableCoverageEntry[];
  missing: string[];
  complete: boolean;
}

/**
 * Audit an error table against {@link STANDARD_ERROR_PROBES}: every probe
 * always RESOLVES (the fallback is mandatory), but the conformance gate wants
 * the common tiers + timeout/network to land on an EXPLICIT row — fallback
 * hits are reported as `missing`.
 */
export function errorTableCompleteness(table: ErrorTable): ErrorTableCompletenessReport {
  const entries: ErrorTableCoverageEntry[] = [];
  const missing: string[] = [];
  for (const { label, probe } of STANDARD_ERROR_PROBES) {
    const index = findRowIndex(table, probe);
    const hit = index === -1 ? table.fallback : (table.rows[index] ?? table.fallback);
    const entry: ErrorTableCoverageEntry = {
      probe: label,
      code: hit.code,
      retryable: hit.retryable,
      failover: hit.failover,
      via: index === -1 ? 'fallback' : 'row',
    };
    if (index !== -1) entry.rowIndex = index;
    entries.push(entry);
    if (index === -1) missing.push(label);
  }
  return { entries, missing, complete: missing.length === 0 };
}

// --- dialect aggregate (§6) -----------------------------------------------------

/**
 * What ONE operation supports on this dialect: the UPSTREAM FETCH capability
 * set (§3 vocabulary — `direct` one-shot HTTP / `stream` SSE / `submit_poll` /
 * `submit_callback`). NOTE this is 上游取数能力, NOT the external paradigm set
 * — external paradigms hang on the MODEL (hard principle #2); the execution
 * planner intersects the two when it validates an offering's fetch_profile.
 */
export interface OperationSupport {
  fetchModes: readonly FetchMode[];
}

/**
 * A versioned dialect — the unit the registry stores and an offering's
 * channel references by `{ref, version}` (§6 热更新一致性: multi-replica
 * consistency by exact version pinning; canary = switch version per-offering,
 * NEVER an implicit latest).
 *
 * Required aspects: ① `requestMapping`, ③ `credentialInjection`,
 * ⑤ `responseNormalization`, plus the total `errorTable`. Optional:
 * ② `mediaInjection` (dialects without media inputs omit it — the pipeline
 * errors if media arrives anyway), ④ `transport` (absent → the pipeline's
 * default HTTP/SSE transport), ⑥ `taskLifecycle` (only submit_poll /
 * submit_callback capable dialects).
 */
export interface Dialect {
  ref: string;
  version: string;
  operations: Partial<Record<Operation, OperationSupport>>;
  requestMapping: RequestMappingAspect;
  mediaInjection?: MediaInjectionAspect;
  credentialInjection: CredentialInjectionAspect;
  transport?: TransportAspect;
  responseNormalization: ResponseNormalizationAspect;
  taskLifecycle?: TaskLifecycleAspect;
  errorTable: ErrorTable;
}
