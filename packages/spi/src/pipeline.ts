// packages/spi/src/pipeline.ts
//
// model-supply-greenfield 批次2 slice 1 — the EXECUTION PIPELINE composing the
// six aspects in their fixed order (§6): ① request mapping → ② media
// injection (when media present AND the dialect declares the aspect) →
// [pipeline-internal URL resolve against ctx.baseUrl] → ③ credential
// injection (output DEEP-FROZEN — 产出即冻结) → ④ transport (dialect override
// or the default HTTP/SSE transport) → ⑤ response normalization. Task-path
// runners compose ⑥ with ③+④; `handleCallback` is inbound-only (no transport).
//
// The pipeline is the ONLY orchestrator; aspects stay stateless pure structure
// (§4.1: the planner is the sole executor of offering declarations — the SPI
// never sees them).
import type {
  CredentialSecret,
  EffectiveParams,
  GatewayError,
  GatewayUsage,
  HttpClient,
  HttpRequest,
  Operation,
  StreamFrame,
  TaskUpdate,
} from '@actionow/contracts';

import type {
  Dialect,
  DialectContext,
  ErrorProbe,
  FrozenWireRequest,
  NormalizedResponse,
  RawCallback,
  RequestMappingInput,
  ResolvedMediaInput,
  StreamFrameResult,
  SubmitParse,
  TaskLifecycleAspect,
  TimeoutBudget,
  TransportAspect,
  WireRequestDraft,
  WireResponse,
  WireStreamResponse,
} from './aspects.js';
import { composeWireUrl, resolveError } from './aspects.js';
import { parseSseBounded } from './sse.js';

// --- deps & inputs ----------------------------------------------------------------

/** What the pipeline needs from its host (engine, batch 3): an HttpClient, the resolved four-timeout budget (§6-④), and the channel's egress proxy. */
export interface PipelineDeps {
  http: HttpClient;
  budget?: TimeoutBudget;
  proxyUrl?: string;
}

/**
 * One upstream execution's input — the planner's post-routing hand-off for
 * the SELECTED offering: operation + `upstream_model_name` + EffectiveParams
 * (§4.1 layer 2 output), resolved media (I/O already done by the upper-layer
 * resolver, §6-②), the drawn credential's secret (§2.4 key pool), and the
 * channel-scoped dialect context.
 */
export interface SyncRunInput {
  operation: Operation;
  upstreamModelName: string;
  params: EffectiveParams;
  media?: ResolvedMediaInput[];
  secret: CredentialSecret;
  ctx: DialectContext;
}

export type SyncRunResult =
  | { ok: true; output: unknown; usage: GatewayUsage; servedRaw?: unknown }
  | { ok: false; error: GatewayError };

/**
 * A running upstream stream. `firstFrame` resolves at the 「首帧已达」 instant —
 * the §3 pre-commit hook: the caller answers 200 only after the first frame
 * pulled through (an `error` first frame = the open failed → a REAL HTTP
 * error, no stream). `frames` REPLAYS that first frame then continues — the
 * full normalized frame sequence. The underlying pull starts eagerly at call
 * time; all failures surface as terminal `error` frames (v0.0.9 semantics:
 * an error frame ends the stream, no [DONE]).
 */
export interface StreamRunHandle {
  firstFrame: Promise<StreamFrame>;
  frames: AsyncIterable<StreamFrame>;
}

export type TaskSubmitResult =
  | { ok: true; kind: 'task'; upstreamTaskId: string; servedRaw?: unknown }
  | { ok: true; kind: 'inline'; output: unknown; usage: GatewayUsage; servedRaw?: unknown }
  | { ok: false; error: GatewayError };

export type TaskUpdateResult =
  | { ok: true; update: TaskUpdate; servedRaw?: unknown }
  | { ok: false; error: GatewayError };

// --- internal error plumbing ---------------------------------------------------------

/** An authoring/configuration defect detected by the pipeline itself (missing aspect, unresolvable URL, unsupported body kind …) — surfaced as `internal_error`, never blamed on the upstream via the error table. */
class PipelineConfigError extends Error {}

function internalError(message: string): GatewayError {
  return { code: 'internal_error', message, retryable: false, failover: false };
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Classify a transport-level throw (no HTTP response) as a timeout or network probe for the dialect's error table (§6 一致性门: 超时/网络错可归类). Heuristic on name/message; unknowable → network. */
function transportThrowProbe(err: unknown): ErrorProbe {
  const message = errorMessageOf(err);
  const name = err instanceof Error ? err.name : '';
  const kind =
    /timeout|timed.?out|abort/i.test(message) || /timeout|abort/i.test(name)
      ? ('timeout' as const)
      : ('network' as const);
  return { kind, message };
}

function configOrInternal(err: unknown): GatewayError {
  if (err instanceof PipelineConfigError || err instanceof TypeError) {
    return internalError(errorMessageOf(err));
  }
  return internalError(`adapter aspect threw: ${errorMessageOf(err)}`);
}

// --- freezing & URL resolution ----------------------------------------------------------

/**
 * Recursively `Object.freeze` a value (freeze-before-descend, so cycles
 * terminate). ArrayBuffer views are skipped — the runtime cannot freeze
 * element storage — so embedded media bytes stay writable while every
 * structural field is locked (§6-③: 注入后请求冻结, mutation throws in strict
 * mode).
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const obj: object = value;
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return value;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const child: unknown = (obj as Record<string, unknown>)[key];
    if (
      child !== null &&
      (typeof child === 'object' || typeof child === 'function') &&
      !Object.isFrozen(child)
    ) {
      deepFreeze(child);
    }
  }
  return value;
}

/** True when the path already carries a scheme + host. */
function isAbsoluteUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/**
 * Resolve a channel-relative draft path against `ctx.baseUrl` (plain
 * prefix-join, preserving the base's path segments — `new URL` semantics
 * would drop them). Runs BETWEEN aspects ② and ③ so signers (③) bind the
 * final absolute URL and transport (④) needs no context.
 */
function resolveDraftUrl(draft: WireRequestDraft, baseUrl: string | undefined): WireRequestDraft {
  if (isAbsoluteUrl(draft.path)) return draft;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new PipelineConfigError(
      `wire request path "${draft.path}" is relative and the dialect context has no baseUrl`,
    );
  }
  const joined = `${baseUrl.replace(/\/+$/, '')}/${draft.path.replace(/^\/+/, '')}`;
  return { ...draft, path: joined };
}

// --- timeout budget → HttpRequest (§6-④) --------------------------------------------------

/**
 * Map the four-timeout budget onto {@link HttpRequest} fields (pure; only
 * fills fields the request left unset — same precedence as the legacy engine
 * wrapper): `totalTimeoutMs` → `timeoutMs`, `connectTimeoutMs` →
 * `connectTimeoutMs`, `ttftTimeoutMs` → `firstChunkTimeoutMs`,
 * `idleTimeoutMs` → `idleTimeoutMs`.
 */
export function applyTimeoutBudget(
  req: HttpRequest,
  budget: TimeoutBudget | undefined,
): HttpRequest {
  const out: HttpRequest = { ...req };
  if (budget === undefined) return out;
  if (budget.totalTimeoutMs !== undefined && out.timeoutMs === undefined) {
    out.timeoutMs = budget.totalTimeoutMs;
  }
  if (budget.connectTimeoutMs !== undefined && out.connectTimeoutMs === undefined) {
    out.connectTimeoutMs = budget.connectTimeoutMs;
  }
  if (budget.ttftTimeoutMs !== undefined && out.firstChunkTimeoutMs === undefined) {
    out.firstChunkTimeoutMs = budget.ttftTimeoutMs;
  }
  if (budget.idleTimeoutMs !== undefined && out.idleTimeoutMs === undefined) {
    out.idleTimeoutMs = budget.idleTimeoutMs;
  }
  return out;
}

// --- default transport (§6-④ 默认实现由 pipeline 提供) ---------------------------------------

function buildHttpRequest(
  req: FrozenWireRequest,
  budget: TimeoutBudget | undefined,
  proxyUrl: string | undefined,
): HttpRequest {
  if (req.method !== 'GET' && req.method !== 'POST') {
    throw new PipelineConfigError(
      `default transport cannot carry method ${req.method} (HttpClient supports GET/POST); provide a custom TransportAspect`,
    );
  }
  if (req.bodyKind === 'form' || req.bodyKind === 'multipart') {
    throw new PipelineConfigError(
      `default transport cannot carry a "${req.bodyKind}" body faithfully (HttpClient JSON-serializes bodies); provide a custom TransportAspect`,
    );
  }
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (req.bodyKind === 'json' && req.body !== undefined && !hasContentType) {
    headers['content-type'] = 'application/json';
  }
  const base: HttpRequest = { method: req.method, url: composeWireUrl(req), headers };
  if (req.bodyKind === 'json' && req.body !== undefined) base.body = req.body;
  const out = applyTimeoutBudget(base, budget);
  if (proxyUrl !== undefined) out.proxyUrl = proxyUrl;
  return out;
}

/**
 * The pipeline-provided aspect ④ (§6-④): buffered request + SSE stream over
 * the platform {@link HttpClient} (which owns the four timeouts and the
 * proxy). Limits of the frozen HttpClient contract are surfaced LOUDLY
 * (GET/POST only, json/none bodies only, no response headers) — dialects
 * needing more implement a custom {@link TransportAspect}.
 */
export const defaultTransport: TransportAspect = {
  async request(req, http, budget, proxyUrl) {
    const res = await http.request(buildHttpRequest(req, budget, proxyUrl));
    return { status: res.status, headers: {}, body: res.body, text: res.text };
  },
  async stream(req, http, budget, proxyUrl) {
    const stream = http.stream?.bind(http);
    if (stream === undefined) {
      throw new PipelineConfigError('the provided HttpClient does not implement stream()');
    }
    const res = await stream(buildHttpRequest(req, budget, proxyUrl));
    return { status: res.status, lines: res.lines };
  },
};

// --- shared aspect composition (① → ② → resolve → ③ freeze) -------------------------------

async function prepareRequest(
  dialect: Dialect,
  draft0: WireRequestDraft,
  media: ResolvedMediaInput[] | undefined,
  secret: CredentialSecret,
  ctx: DialectContext,
): Promise<FrozenWireRequest> {
  let draft = draft0;
  if (media !== undefined && media.length > 0) {
    if (dialect.mediaInjection === undefined) {
      throw new PipelineConfigError(
        `dialect ${dialect.ref}@${dialect.version} declares no mediaInjection aspect but media inputs were provided`,
      );
    }
    draft = await dialect.mediaInjection.inject(draft, media, ctx); // ②
  }
  draft = resolveDraftUrl(draft, ctx.baseUrl); // pipeline-internal, pre-③
  const injected = dialect.credentialInjection.injectCredential(draft, secret, ctx); // ③
  return deepFreeze(injected); // 产出即冻结 — later mutation throws
}

function mappingInput(input: SyncRunInput, stream: boolean): RequestMappingInput {
  return {
    operation: input.operation,
    upstreamModelName: input.upstreamModelName,
    params: input.params,
    stream,
    ctx: input.ctx,
  };
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Build the error-table probe for a non-2xx TASK-path response (⑥ parse methods see 2xx only; ⑤ `normalize` by contrast sees every status). */
function httpProbe(res: WireResponse): ErrorProbe {
  const probe: ErrorProbe = { httpStatus: res.status };
  const message = res.text ?? safeStringify(res.body);
  if (message !== undefined) probe.message = message;
  return probe;
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// --- runSync (§6: ①→②→③→④→⑤) ---------------------------------------------------------------

/**
 * Execute one buffered (fetch mode `direct`) upstream call: ① map → ② inject
 * media → ③ inject credential (freeze) → ④ transport → ⑤ normalize.
 * Aspect/authoring failures → `internal_error`; transport-level throws →
 * timeout/network probes on the dialect's error table; EVERY completed
 * exchange (any status) goes to ⑤ `normalize`, which owns the full
 * translation (§6-⑤ incl. 200-carried business errors).
 */
export async function runSync(
  dialect: Dialect,
  input: SyncRunInput,
  deps: PipelineDeps,
): Promise<SyncRunResult> {
  let frozen: FrozenWireRequest;
  try {
    const draft = dialect.requestMapping.map(mappingInput(input, false)); // ①
    frozen = await prepareRequest(dialect, draft, input.media, input.secret, input.ctx); // ②③
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  const transport = dialect.transport ?? defaultTransport;
  let res: WireResponse;
  try {
    res = await transport.request(frozen, deps.http, deps.budget ?? {}, deps.proxyUrl); // ④
  } catch (err) {
    if (err instanceof PipelineConfigError) return { ok: false, error: internalError(err.message) };
    return { ok: false, error: resolveError(dialect.errorTable, transportThrowProbe(err)) };
  }
  let normalized: NormalizedResponse;
  try {
    normalized = dialect.responseNormalization.normalize(res, input.ctx); // ⑤
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  if (!normalized.ok) return { ok: false, error: normalized.error };
  return { ok: true, output: normalized.output, usage: normalized.usage, servedRaw: res.body };
}

// --- runStream (§6: ①→②→③→④(stream)→⑤ per frame) --------------------------------------------

const STREAM_ERROR_BODY_CAP_BYTES = 64 * 1024;

/** Drain (bounded) a failed stream-open's body so ⑤ can translate the error payload. */
async function drainCapped(lines: AsyncIterable<string>): Promise<string> {
  let text = '';
  try {
    for await (const chunk of lines) {
      text += chunk;
      if (Buffer.byteLength(text, 'utf8') >= STREAM_ERROR_BODY_CAP_BYTES) break;
    }
  } catch {
    // The body was best-effort context; translation proceeds on what arrived.
  }
  return text;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorFrame(error: GatewayError): StreamFrame {
  return { kind: 'error', error };
}

/**
 * Execute one streaming (fetch mode `stream`) upstream call. Same ①②③
 * composition (with `stream: true`), ④ opens the byte stream, the BOUNDED SSE
 * framer (sse.ts) assembles events, and ⑤ `normalizeStreamFrame` translates
 * each into zero-or-more {@link StreamFrame}s (one shared scratch state per
 * stream). The stream ends after the first terminal frame (`done` / `error`).
 * A non-2xx open is drained (capped) and handed to ⑤ `normalize` — the caller
 * sees an `error` FIRST frame and never commits (§3 pre-commit).
 */
export function runStream(
  dialect: Dialect,
  input: SyncRunInput,
  deps: PipelineDeps,
): StreamRunHandle {
  async function* produce(): AsyncGenerator<StreamFrame> {
    let frozen: FrozenWireRequest;
    try {
      const draft = dialect.requestMapping.map(mappingInput(input, true)); // ①
      frozen = await prepareRequest(dialect, draft, input.media, input.secret, input.ctx); // ②③
    } catch (err) {
      yield errorFrame(configOrInternal(err));
      return;
    }
    const transport = dialect.transport ?? defaultTransport;
    let opened: WireStreamResponse;
    try {
      opened = await transport.stream(frozen, deps.http, deps.budget ?? {}, deps.proxyUrl); // ④
    } catch (err) {
      if (err instanceof PipelineConfigError) {
        yield errorFrame(internalError(err.message));
        return;
      }
      yield errorFrame(resolveError(dialect.errorTable, transportThrowProbe(err)));
      return;
    }

    if (!is2xx(opened.status)) {
      const text = await drainCapped(opened.lines);
      const res: WireResponse = { status: opened.status, headers: {}, body: tryParseJson(text) };
      if (text.length > 0) res.text = text;
      let normalized: NormalizedResponse;
      try {
        normalized = dialect.responseNormalization.normalize(res, input.ctx); // ⑤ (error path)
      } catch (err) {
        yield errorFrame(configOrInternal(err));
        return;
      }
      yield errorFrame(
        normalized.ok
          ? internalError(
              `dialect ${dialect.ref}@${dialect.version} normalized a non-2xx stream open (HTTP ${String(opened.status)}) as success`,
            )
          : normalized.error,
      );
      return;
    }

    const state: Record<string, unknown> = {};
    let emitted = false;
    for await (const item of parseSseBounded(opened.lines)) {
      if (item.kind === 'error') {
        emitted = true;
        yield errorFrame(item.error);
        return;
      }
      let verdict: StreamFrameResult;
      try {
        verdict = dialect.responseNormalization.normalizeStreamFrame(item.data, state); // ⑤ per frame
      } catch (err) {
        emitted = true;
        yield errorFrame(configOrInternal(err));
        return;
      }
      if (!Array.isArray(verdict)) {
        emitted = true;
        yield errorFrame(verdict.error);
        return;
      }
      for (const frame of verdict) {
        emitted = true;
        yield frame;
        if (frame.kind === 'done' || frame.kind === 'error') return; // terminal
      }
    }
    if (!emitted) {
      // An upstream that opened 2xx but produced nothing is a protocol
      // violation — surface it so pre-commit never blesses an empty stream.
      yield errorFrame({
        code: 'upstream_error',
        message: 'upstream stream ended before producing any frame',
        retryable: true,
        failover: true,
      });
    }
  }

  const source = produce();
  const first = source.next(); // eager pull-through — the 「首帧已达」 instant
  const firstFrame: Promise<StreamFrame> = first.then((r) =>
    r.done
      ? errorFrame({
          code: 'upstream_error',
          message: 'upstream stream ended before producing any frame',
          retryable: true,
          failover: true,
        })
      : r.value,
  );
  async function* replay(): AsyncGenerator<StreamFrame> {
    const r = await first;
    if (r.done) return;
    yield r.value;
    for (;;) {
      const n = await source.next();
      if (n.done) return;
      yield n.value;
    }
  }
  return { firstFrame, frames: replay() };
}

// --- task-path runners (⑥ + ③ + ④; §6-⑥) ------------------------------------------------------

function taskLifecycleOf(dialect: Dialect): TaskLifecycleAspect {
  const tl = dialect.taskLifecycle;
  if (tl === undefined) {
    throw new PipelineConfigError(
      `dialect ${dialect.ref}@${dialect.version} declares no taskLifecycle aspect`,
    );
  }
  return tl;
}

/**
 * Submit a task upstream (fetch modes `submit_poll` / `submit_callback`):
 * ⑥ `buildSubmit` (aspect-①-shaped input) → ② media injection (when media
 * present) → ③ credential (freeze) → ④ transport → ⑥ `parseSubmitResponse`.
 * Non-2xx → the dialect's error table; 2xx-carried rejections come back from
 * the parse as `{error}`. `kind: 'task'` carries the upstream handle (§7
 * correlation key); `kind: 'inline'` = the upstream completed synchronously.
 */
export async function runTaskSubmit(
  dialect: Dialect,
  input: SyncRunInput,
  deps: PipelineDeps,
): Promise<TaskSubmitResult> {
  let frozen: FrozenWireRequest;
  let tl: TaskLifecycleAspect;
  try {
    tl = taskLifecycleOf(dialect);
    const draft = tl.buildSubmit(mappingInput(input, false)); // ⑥ build
    frozen = await prepareRequest(dialect, draft, input.media, input.secret, input.ctx); // ②③
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  const transport = dialect.transport ?? defaultTransport;
  let res: WireResponse;
  try {
    res = await transport.request(frozen, deps.http, deps.budget ?? {}, deps.proxyUrl); // ④
  } catch (err) {
    if (err instanceof PipelineConfigError) return { ok: false, error: internalError(err.message) };
    return { ok: false, error: resolveError(dialect.errorTable, transportThrowProbe(err)) };
  }
  if (!is2xx(res.status)) {
    return { ok: false, error: resolveError(dialect.errorTable, httpProbe(res)) };
  }
  let parsed: SubmitParse;
  try {
    parsed = tl.parseSubmitResponse(res); // ⑥ parse
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'upstream_error',
        message: `failed to parse submit response: ${errorMessageOf(err)}`,
        retryable: false,
        failover: false,
      },
    };
  }
  if ('error' in parsed) return { ok: false, error: parsed.error };
  if ('inline' in parsed) {
    return {
      ok: true,
      kind: 'inline',
      output: parsed.inline.output,
      usage: parsed.inline.usage,
      servedRaw: res.body,
    };
  }
  return { ok: true, kind: 'task', upstreamTaskId: parsed.upstreamTaskId, servedRaw: res.body };
}

/** Arguments shared by the query/cancel runners: the §7 upstream handle + the credential and channel context to re-sign the call (poll calls MUST re-sign — body-bound signatures). */
export interface TaskProbeInput {
  upstreamTaskId: string;
  secret: CredentialSecret;
  ctx: DialectContext;
}

async function runTaskProbe(
  dialect: Dialect,
  input: TaskProbeInput,
  deps: PipelineDeps,
  build: (upstreamTaskId: string, ctx: DialectContext) => WireRequestDraft,
  parse: (res: WireResponse) => TaskUpdate,
): Promise<TaskUpdateResult> {
  let frozen: FrozenWireRequest;
  try {
    const draft = build(input.upstreamTaskId, input.ctx); // ⑥ build
    frozen = await prepareRequest(dialect, draft, undefined, input.secret, input.ctx); // ③
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  const transport = dialect.transport ?? defaultTransport;
  let res: WireResponse;
  try {
    res = await transport.request(frozen, deps.http, deps.budget ?? {}, deps.proxyUrl); // ④
  } catch (err) {
    if (err instanceof PipelineConfigError) return { ok: false, error: internalError(err.message) };
    return { ok: false, error: resolveError(dialect.errorTable, transportThrowProbe(err)) };
  }
  if (!is2xx(res.status)) {
    return { ok: false, error: resolveError(dialect.errorTable, httpProbe(res)) };
  }
  try {
    return { ok: true, update: parse(res), servedRaw: res.body }; // ⑥ parse → TaskUpdate IR
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'upstream_error',
        message: `failed to parse task response: ${errorMessageOf(err)}`,
        retryable: false,
        failover: false,
      },
    };
  }
}

/** Poll one task's upstream state: ⑥ `buildQuery` → ③ → ④ → ⑥ `parseQueryResponse` (a typed {@link TaskUpdate} — the fixed envelope, §6-⑥). */
export async function runTaskQuery(
  dialect: Dialect,
  input: TaskProbeInput,
  deps: PipelineDeps,
): Promise<TaskUpdateResult> {
  let tl: TaskLifecycleAspect;
  try {
    tl = taskLifecycleOf(dialect);
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  return runTaskProbe(
    dialect,
    input,
    deps,
    (id, ctx) => tl.buildQuery(id, ctx),
    (res) => tl.parseQueryResponse(res),
  );
}

/**
 * Forward a cancel upstream (§7.7: 上游支持则转发). A dialect without
 * `buildCancel`/`parseCancelResponse` yields `internal_error` — callers should
 * check the aspect's presence first and fall back to local-mark semantics.
 */
export async function runTaskCancel(
  dialect: Dialect,
  input: TaskProbeInput,
  deps: PipelineDeps,
): Promise<TaskUpdateResult> {
  let tl: TaskLifecycleAspect;
  try {
    tl = taskLifecycleOf(dialect);
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  const buildCancel = tl.buildCancel?.bind(tl);
  const parseCancelResponse = tl.parseCancelResponse?.bind(tl);
  if (buildCancel === undefined || parseCancelResponse === undefined) {
    return {
      ok: false,
      error: internalError(
        `dialect ${dialect.ref}@${dialect.version} does not support upstream cancel`,
      ),
    };
  }
  return runTaskProbe(dialect, input, deps, buildCancel, parseCancelResponse);
}

/**
 * Handle an INBOUND upstream callback (§6-⑥; no transport): ⑥ `verifyCallback`
 * over the raw bytes → only if authentic, ⑥ `parseCallback` → typed
 * {@link TaskUpdate}. An unverified callback is REJECTED unparsed
 * (`unauthorized`) — the §3 submit_callback chain (验签→去重→乱序容忍→反查确认)
 * starts at this gate; dedupe/ordering/re-query live in the task center
 * (batch 4).
 */
export function handleCallback(
  dialect: Dialect,
  raw: RawCallback,
  secret: CredentialSecret | undefined,
  ctx: DialectContext,
): TaskUpdateResult {
  let tl: TaskLifecycleAspect;
  try {
    tl = taskLifecycleOf(dialect);
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  let verified: boolean;
  try {
    verified = tl.verifyCallback(raw, secret, ctx);
  } catch (err) {
    return { ok: false, error: configOrInternal(err) };
  }
  if (!verified) {
    return {
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'callback signature verification failed',
        retryable: false,
        failover: false,
      },
    };
  }
  try {
    return { ok: true, update: tl.parseCallback(raw) };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: `failed to parse callback: ${errorMessageOf(err)}`,
        retryable: false,
        failover: false,
      },
    };
  }
}
