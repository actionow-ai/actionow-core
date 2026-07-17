// packages/engine/src/gateway/golden-probe.ts
//
// model-supply-greenfield 批次5 slice1 — the GOLDEN PROBE (§10 真上游小样探测):
// the OFFERING admission door. Two doors, two owners: the conformance suite
// (mock upstream, batch 2) admits DIALECTS; this probe hits the REAL upstream
// with a minimal sample (chat ping / minimal-tier media / short submit-poll)
// and its verdict gates the offering's draft/probing → enabled transition.
//
// THIN EXECUTION red lines (this is a diagnosis, not a serve):
//   - no task row, no wallet hold/settle, no admission semaphore, no breaker
//     samples — structurally guaranteed: the deps carry NONE of those surfaces
//     (only db reads for the credential pool + vault, the SPI registry and an
//     HttpClient);
//   - R5 探测预算: a real upstream costs real money — the daily platform
//     budget + per-offering min interval refuse a probe BEFORE any upstream
//     byte (BYOK channels probe on the tenant's own key: the probe cost
//     belongs to that tenant, so only platform-operated channels charge the
//     platform budget; the min interval applies to ALL channels — it guards
//     the upstream, not the wallet);
//   - media probes are FORCED to the minimal tier server-side (billing
//     relevant params pinned to their cheapest enumerable value; the probe
//     endpoint accepts no caller params at all, so nothing can inflate it).
//
// The probe deliberately runs the REAL config path: credential pool →
// resolveDialectForOffering → offering param declarations through the REAL
// layer-2 resolver (resolveEffectiveParams) → the REAL SPI pipeline — so a
// passing probe certifies the offering AS CONFIGURED, not a hand-built call.
import type {
  CanonicalParam,
  CanonicalParamValue,
  GatewayError,
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  ModelOperation,
  OfferingParamDecl,
  Operation,
} from '@actionow/contracts';
import type { DbOrTx, SupplyCredentialRow } from '@actionow/db';
import { listActiveCredentialsForChannel, resolveSupplyCredentialSecret } from '@actionow/db';
import type { DialectRegistry, PipelineDeps, SyncRunInput } from '@actionow/spi';
import { runStream, runSync, runTaskQuery, runTaskSubmit } from '@actionow/spi';

import { resolveEffectiveParams } from '../planner/effective-params.js';
import type { ResolveDialectProvider } from './dialect-resolve.js';
import { resolveDialectForOffering } from './dialect-resolve.js';

// --- probe economics (R5) -------------------------------------------------------

/**
 * Conservative per-probe cost ESTIMATES (USD) charged against the daily
 * platform budget at ADMISSION (pessimistic — a refused upstream still spent
 * its slot). Real cost attribution is the reconciliation pipeline's; these
 * bound the blast radius of a probe loop: at the default 5 USD/day that is
 * ~500 chat pings or ~25 media samples.
 */
export const CHAT_PROBE_EST_USD = 0.01;
export const MEDIA_PROBE_EST_USD = 0.2;

/** Operations probed with a one-line chat-class ping (cheap). Everything else is media/task class. */
const CHAT_CLASS_OPERATIONS: readonly Operation[] = [
  'chat.completions',
  'embeddings',
  'rerank',
  'moderations',
];

/** Wall-clock ceiling for one probe (§R5 短样): poll budget = min(offering budget, model max_run, THIS). */
export const PROBE_MAX_BUDGET_SECONDS = 120;
/** Task-path poll cadence (mirrors the old model-test's 2.5s). */
export const PROBE_POLL_INTERVAL_MS = 2_500;
/** Chat probe output cap — a chatty model can't run up cost on a ping (old model-test carry-over). */
export const CHAT_PROBE_MAX_TOKENS = 32;
/** The ping the chat-class probe sends (old model-test carry-over — the 判据 is a non-empty completion). */
export const CHAT_PROBE_PING = 'Reply with the single word: ok';
/** Minimal media prompt (old minimalMediaInputs carry-over). */
export const MEDIA_PROBE_PROMPT = 'a small red circle on white';

// --- budget gate (R5) ------------------------------------------------------------

export interface ProbeAdmissionInput {
  offeringId: string;
  /** Estimated probe cost in USD (charged at admission when platform-funded). */
  estUsd: number;
  /** false = BYOK channel (tenant's own key) — min interval applies, budget does not. */
  platformFunded: boolean;
  /** Effective PROBE_DAILY_BUDGET_USD (SettingsResolver). */
  dailyBudgetUsd: number;
  /** Effective PROBE_MIN_INTERVAL_SEC (SettingsResolver); 0 = unlimited. */
  minIntervalSec: number;
  nowMs: number;
}

export type ProbeAdmission =
  | { ok: true }
  | { ok: false; reason: 'budget_exceeded' | 'min_interval'; retryAfterSeconds: number };

/** The R5 admission gate the probe consults BEFORE any upstream byte. */
export interface ProbeBudgetGate {
  admit(input: ProbeAdmissionInput): ProbeAdmission;
}

/**
 * The default in-process budget gate: a UTC-day USD accumulator (platform-
 * funded probes only) + a per-offering last-probe clock. Charging happens AT
 * admission (pessimistic). Per-replica state is a DOCUMENTED bound, not a
 * precise ledger: N replicas admit at most N× the daily budget — acceptable
 * for an admin-driven probe surface; a shared (redis) gate is the batch-5
 * slice-2 batching follow-up if 发现批建 needs cross-replica precision.
 */
export class InMemoryProbeBudget implements ProbeBudgetGate {
  private day = '';
  private spentUsd = 0;
  private readonly lastProbeAtMs = new Map<string, number>();

  admit(input: ProbeAdmissionInput): ProbeAdmission {
    const last = this.lastProbeAtMs.get(input.offeringId);
    if (input.minIntervalSec > 0 && last !== undefined) {
      const elapsedMs = input.nowMs - last;
      const intervalMs = input.minIntervalSec * 1000;
      if (elapsedMs < intervalMs) {
        return {
          ok: false,
          reason: 'min_interval',
          retryAfterSeconds: Math.ceil((intervalMs - elapsedMs) / 1000),
        };
      }
    }
    if (input.platformFunded) {
      const day = new Date(input.nowMs).toISOString().slice(0, 10);
      if (day !== this.day) {
        this.day = day;
        this.spentUsd = 0;
      }
      if (this.spentUsd + input.estUsd > input.dailyBudgetUsd) {
        const nextMidnightMs = Date.parse(`${day}T00:00:00.000Z`) + 24 * 3600 * 1000;
        return {
          ok: false,
          reason: 'budget_exceeded',
          retryAfterSeconds: Math.max(1, Math.ceil((nextMidnightMs - input.nowMs) / 1000)),
        };
      }
      this.spentUsd += input.estUsd; // pessimistic charge at admission.
    }
    this.lastProbeAtMs.set(input.offeringId, input.nowMs);
    return { ok: true };
  }
}

// --- deps & subject ---------------------------------------------------------------

/** The two db reads the probe performs (injectable — tests run on fakes + POISONED_DB). */
export interface GoldenProbeQueries {
  listActiveCredentialsForChannel: typeof listActiveCredentialsForChannel;
  resolveSupplyCredentialSecret: typeof resolveSupplyCredentialSecret;
}

export interface GoldenProbeDeps {
  db: DbOrTx;
  /** The versioned SPI registry (§6) — the SAME one the gateway serves from. */
  registry: DialectRegistry;
  /** The probe's own HttpClient (infra fetch client at the API layer — independent of request traffic). */
  http: HttpClient;
  /** R5 admission gate; absent → no budget enforcement (tests / trusted internal callers). */
  budget?: ProbeBudgetGate | undefined;
  /** Effective R5 limits (SettingsResolver-read at the API layer). Required when `budget` is set. */
  limits?: { dailyBudgetUsd: number; minIntervalSec: number } | undefined;
  nowMs?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pollIntervalMs?: number | undefined;
  /** Resolve channel.proxy_ref → egress proxy URL; absent → direct egress. */
  resolveProxyUrl?: ((proxyRef: string) => Promise<string | undefined>) | undefined;
  queries?: Partial<GoldenProbeQueries> | undefined;
}

/** The channel facts the probe consumes (structurally satisfied by SupplyChannelRow). */
export interface GoldenProbeChannel {
  id: string;
  dialect: { ref: string; version: string } | null;
  baseUrl: string | null;
  region: string | null;
  proxyRef: string | null;
  /** BYOK owner; null = 平台自营 (probe cost charges the platform budget). */
  tenantId: string | null;
}

/** The offering facts the probe consumes (structurally satisfied by SupplyOfferingRow). */
export interface GoldenProbeOffering {
  id: string;
  upstreamModelName: string;
  fetchProfile: { mode: 'direct' | 'stream' | 'submit_poll' | 'submit_callback' };
  paramDeclarations: OfferingParamDecl[];
  timeoutBudgetSeconds: number | null;
}

/** The model facts the probe consumes (structurally satisfied by SupplyModelRow). */
export interface GoldenProbeModel {
  operations: ModelOperation[];
  maxRunTimeSeconds: number | null;
}

export interface GoldenProbeSubject {
  offering: GoldenProbeOffering;
  channel: GoldenProbeChannel;
  provider?: ResolveDialectProvider | undefined;
  model: GoldenProbeModel;
  /** Probe a specific operation surface; default = the model's FIRST operation (primary surface). */
  operation?: Operation | undefined;
}

// --- result ------------------------------------------------------------------------

export interface ProbeCheck {
  ok: boolean;
  message: string;
  code?: string | undefined;
}

export interface ProbeRunResult {
  offeringId: string;
  operation: Operation;
  connectivity: ProbeCheck;
  functional: ProbeCheck;
  sample?: { text?: string | undefined; url?: string | undefined } | undefined;
  elapsedMs: number;
}

export type GoldenProbeOutcome =
  | { status: 'completed'; result: ProbeRunResult }
  | {
      status: 'rejected';
      reason: 'budget_exceeded' | 'min_interval';
      message: string;
      retryAfterSeconds: number;
    };

// --- small helpers -------------------------------------------------------------------

function pass(message: string): ProbeCheck {
  return { ok: true, message };
}
function fail(message: string, code?: string): ProbeCheck {
  return code !== undefined ? { ok: false, message, code } : { ok: false, message };
}

/** Both legs failed for the same pre-flight reason (config defect — the upstream was never reached). */
function bothFail(check: ProbeCheck): Pick<ProbeRunResult, 'connectivity' | 'functional'> {
  return { connectivity: check, functional: check };
}

/**
 * A reach-tracking HttpClient wrapper: the SPI error tables fold transport
 * throws into the unified taxonomy (network → upstream_error on most
 * dialects), which erases the connectivity-vs-functional distinction the old
 * model-test classified on. The tracker restores it FAITHFULLY: any completed
 * HTTP exchange (any status) proves the upstream was REACHED; a probe that
 * ends with zero completed exchanges failed at the transport.
 */
function reachTracking(inner: HttpClient): { http: HttpClient; reached: () => boolean } {
  let reached = false;
  const http: HttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const res = await inner.request(req);
      reached = true;
      return res;
    },
    ...(inner.stream !== undefined
      ? {
          stream: async (req: HttpRequest): Promise<HttpStreamResponse> => {
            const stream = inner.stream?.bind(inner);
            if (stream === undefined) throw new Error('unreachable: stream vanished');
            const res = await stream(req);
            reached = true;
            return res;
          },
        }
      : {}),
  };
  return { http, reached: () => reached };
}

/**
 * Map a pipeline {@link GatewayError} onto the two legs, given whether ANY
 * HTTP exchange completed. The old model-test 判据 carried over: not reached /
 * unauthorized / first-contact timeout fail connectivity; any other structured
 * error means the upstream was reached and authenticated — connectivity
 * passes, only function fails.
 */
function classify(
  error: GatewayError,
  reached: boolean,
): Pick<ProbeRunResult, 'connectivity' | 'functional'> {
  if (!reached) {
    const check = fail(`could not reach upstream: ${error.message}`, error.code);
    return { connectivity: check, functional: check };
  }
  if (error.code === 'unauthorized' || error.code === 'upstream_timeout') {
    const check = fail(error.message, error.code);
    return { connectivity: check, functional: check };
  }
  return {
    connectivity: pass('reached upstream and authenticated'),
    functional: fail(error.message, error.code),
  };
}

// --- minimal probe params (§R5 最小档 served-side forcing) ------------------------------

/** Best-effort text for a string-typed canonical param, by conventional name. */
function probeText(name: string, chatClass: boolean): string {
  if (name === 'prompt') return MEDIA_PROBE_PROMPT;
  if (name === 'input' || name === 'query' || name === 'text') {
    return chatClass ? CHAT_PROBE_PING : MEDIA_PROBE_PROMPT;
  }
  return 'connectivity test';
}

/** The MINIMAL value for one canonical param: lowest tier for numerics, first declared value for enums. */
function minimalValueOf(param: CanonicalParam, chatClass: boolean): unknown {
  if (param.values !== undefined && param.values.length > 0) return param.values[0];
  switch (param.type) {
    case 'int':
    case 'float':
      return param.min ?? 1;
    case 'boolean':
      return false;
    case 'string':
    case 'enum':
      return probeText(param.name, chatClass);
    case 'json':
      return param.name === 'messages'
        ? [{ role: 'user', content: CHAT_PROBE_PING }]
        : { probe: true };
    case 'file':
    case 'media':
      return undefined; // cannot synthesize media input — handled by the caller.
  }
}

/** Canonical param names conventionally capping generated tokens (probe cost bound). */
const TOKEN_CAP_PARAMS = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'];

/**
 * Build the probe's canonical request params (§4.1 layer-1 stand-in — the
 * probe endpoint accepts NO caller params, so the server-side forcing is
 * total):
 *
 * - billing_relevant params: ALWAYS pinned to the minimal enumerable tier
 *   (values[0] / min), overriding any contract default — §R5 媒体强制最小档;
 * - required params without defaults: synthesized minimally (ping text,
 *   min numerics, first enum value); a required file/media input cannot be
 *   synthesized → reported so the probe fails EXPLAINABLY;
 * - token-cap params (max_tokens…): clamped to {@link CHAT_PROBE_MAX_TOKENS};
 * - everything else: left to its canonical default (isDefault: true rides on
 *   what we do carry so the REAL resolver treats it exactly like a facade).
 */
export function buildProbeRequestParams(
  operation: Operation,
  canonicalParams: CanonicalParam[],
): { params: Record<string, CanonicalParamValue>; missingMedia: string[] } {
  const chatClass = CHAT_CLASS_OPERATIONS.includes(operation);
  const params: Record<string, CanonicalParamValue> = {};
  const missingMedia: string[] = [];
  for (const param of canonicalParams) {
    if (TOKEN_CAP_PARAMS.includes(param.name)) {
      const cap =
        typeof param.max === 'number'
          ? Math.min(CHAT_PROBE_MAX_TOKENS, param.max)
          : CHAT_PROBE_MAX_TOKENS;
      params[param.name] = { value: Math.max(cap, param.min ?? 1), isDefault: false };
      continue;
    }
    if (param.billingRelevant) {
      const v = minimalValueOf(param, chatClass);
      if (v !== undefined) params[param.name] = { value: v, isDefault: false };
      continue;
    }
    if (param.type === 'file' || param.type === 'media') {
      if (param.required && param.default === undefined) missingMedia.push(param.name);
      continue;
    }
    if (param.required && param.default === undefined) {
      const v = minimalValueOf(param, chatClass);
      if (v !== undefined) params[param.name] = { value: v, isDefault: false };
    }
  }
  return { params, missingMedia };
}

// --- sample / verdict extraction ----------------------------------------------------

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c;
  return undefined;
}

function get(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

/** Best-effort URL extraction from a normalized output (media verdict — the old assetUrl carry-over). */
function extractUrl(output: unknown): string | undefined {
  if (output === null || output === undefined) return undefined;
  const direct = firstString(get(output, 'url'));
  if (direct !== undefined) return direct;
  for (const listKey of ['assets', 'data', 'artifacts', 'outputs']) {
    const list = get(output, listKey);
    if (Array.isArray(list) && list.length > 0) {
      const url = firstString(
        get(list[0], 'url'),
        typeof list[0] === 'string' ? list[0] : undefined,
      );
      if (url !== undefined) return url;
    }
  }
  return undefined;
}

/** Best-effort text extraction (chat verdict): plain string / {text} / openai-style choices[0].message.content. */
function extractText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const text = firstString(get(output, 'text'));
  if (text !== undefined) return text;
  if (Array.isArray(output) && output.length > 0) {
    return firstString(get(get(output[0], 'message'), 'content'), get(output[0], 'text'));
  }
  return firstString(get(get(get(output, 'choices'), '0'), 'text'));
}

/** The functional verdict for a produced output (chat-class demands non-empty text; media demands an asset). */
function verdictFromOutput(
  operation: Operation,
  output: unknown,
): Pick<ProbeRunResult, 'connectivity' | 'functional' | 'sample'> {
  const connectivity = pass('reached upstream and authenticated');
  const chatClass = CHAT_CLASS_OPERATIONS.includes(operation);
  if (chatClass) {
    if (operation === 'chat.completions') {
      const text = extractText(output)?.trim() ?? '';
      return text.length > 0
        ? {
            connectivity,
            functional: pass('received a non-empty completion'),
            sample: { text: text.slice(0, 200) },
          }
        : { connectivity, functional: fail('upstream returned an empty completion') };
    }
    // embeddings / rerank / moderations: any non-null normalized output passes.
    return output !== null && output !== undefined
      ? { connectivity, functional: pass('upstream produced a result') }
      : { connectivity, functional: fail('upstream returned an empty result') };
  }
  const url = extractUrl(output);
  if (url !== undefined) {
    return { connectivity, functional: pass('upstream produced an asset'), sample: { url } };
  }
  return output !== null && output !== undefined
    ? { connectivity, functional: pass('upstream produced output (no asset URL detected)') }
    : { connectivity, functional: fail('upstream succeeded but returned no output') };
}

// --- the probe ------------------------------------------------------------------------

/**
 * Run ONE golden probe against the offering's REAL upstream. Never throws for
 * upstream/config reasons — every failure mode lands in the two-leg verdict
 * (operators read messages, the enable gate reads `ok`); only programmer
 * errors escape.
 */
export async function goldenProbe(
  deps: GoldenProbeDeps,
  subject: GoldenProbeSubject,
): Promise<GoldenProbeOutcome> {
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const queries: GoldenProbeQueries = {
    listActiveCredentialsForChannel:
      deps.queries?.listActiveCredentialsForChannel ?? listActiveCredentialsForChannel,
    resolveSupplyCredentialSecret:
      deps.queries?.resolveSupplyCredentialSecret ?? resolveSupplyCredentialSecret,
  };
  const { offering, channel, model } = subject;

  const primaryOp = subject.operation ?? model.operations[0]?.operation;
  const completed = (
    legs: Pick<ProbeRunResult, 'connectivity' | 'functional' | 'sample'>,
  ): GoldenProbeOutcome => ({
    status: 'completed',
    result: {
      offeringId: offering.id,
      operation: primaryOp ?? 'chat.completions',
      elapsedMs: Math.max(0, nowMs() - startedAt),
      ...legs,
    },
  });
  if (primaryOp === undefined) {
    return completed(
      bothFail(fail('model declares no operation surface to probe', 'no_operation')),
    );
  }
  const opContract = model.operations.find((o) => o.operation === primaryOp);
  if (opContract === undefined) {
    return completed(
      bothFail(fail(`model does not declare operation '${primaryOp}'`, 'no_operation')),
    );
  }
  const chatClass = CHAT_CLASS_OPERATIONS.includes(primaryOp);

  // ── R5 admission gate — BEFORE any upstream byte. ─────────────────────────
  if (deps.budget !== undefined) {
    const admission = deps.budget.admit({
      offeringId: offering.id,
      estUsd: chatClass ? CHAT_PROBE_EST_USD : MEDIA_PROBE_EST_USD,
      platformFunded: channel.tenantId === null,
      dailyBudgetUsd: deps.limits?.dailyBudgetUsd ?? 0,
      minIntervalSec: deps.limits?.minIntervalSec ?? 0,
      nowMs: startedAt,
    });
    if (!admission.ok) {
      return {
        status: 'rejected',
        reason: admission.reason,
        retryAfterSeconds: admission.retryAfterSeconds,
        message:
          admission.reason === 'budget_exceeded'
            ? 'golden-probe daily budget exhausted (PROBE_DAILY_BUDGET_USD) — retry after the UTC day rolls'
            : `offering was probed within the minimum interval (PROBE_MIN_INTERVAL_SEC) — retry in ${String(admission.retryAfterSeconds)}s`,
      };
    }
  }

  // ── credential pool (§2.4) — pool head; rotation stays the gate's business. ─
  const pool = await queries.listActiveCredentialsForChannel(
    deps.db,
    channel.id,
    new Date(startedAt),
  );
  const credential: SupplyCredentialRow | undefined = pool[0];
  if (credential === undefined) {
    return completed(
      bothFail(
        fail(`channel ${channel.id} has no active credential to probe with`, 'no_credential'),
      ),
    );
  }
  const secret = await queries.resolveSupplyCredentialSecret(deps.db, credential.id);
  if (secret === undefined) {
    return completed(
      bothFail(
        fail(
          `credential ${credential.id} secret is unresolvable (vault miss or shape drift)`,
          'secret_unresolvable',
        ),
      ),
    );
  }

  // ── dialect + context (§2.2/§2.3/§6 — the SAME resolution the gateway runs). ─
  const resolved = resolveDialectForOffering(
    { registry: deps.registry },
    {
      channel: {
        id: channel.id,
        dialect: channel.dialect,
        baseUrl: channel.baseUrl,
        region: channel.region,
      },
      provider: subject.provider,
      nowMs: startedAt,
    },
  );
  if (!resolved.ok) {
    return completed(bothFail(fail(resolved.error.message, resolved.error.code)));
  }
  // Pin the operation for multi-op dialects (aspect ⑤ carries no operation).
  const ctx = { ...resolved.ctx, config: { ...resolved.ctx.config, operation: primaryOp } };

  // ── minimal params through the REAL layer-2 resolver. ─────────────────────
  const { params: requestParams, missingMedia } = buildProbeRequestParams(
    primaryOp,
    opContract.params,
  );
  if (missingMedia.length > 0) {
    return completed({
      connectivity: fail(
        `probe cannot synthesize required media input(s): ${missingMedia.join(', ')}`,
        'unprobeable_input',
      ),
      functional: fail(
        `probe cannot synthesize required media input(s): ${missingMedia.join(', ')}`,
        'unprobeable_input',
      ),
    });
  }
  const { effective } = resolveEffectiveParams({
    operation: primaryOp,
    canonicalParams: opContract.params,
    requestParams,
    declarations: offering.paramDeclarations,
  });
  // Chat fallback overlay: a chat probe is meaningless without messages; when
  // the canonical contract doesn't declare them (§5 OpenAI-compatible base
  // vocabulary), carry the ping directly on the upstream bag. Token capping
  // stays contract-declared only — inventing a wire name the dialect never
  // documented risks an upstream 400.
  if (primaryOp === 'chat.completions' && effective.upstream.messages === undefined) {
    effective.upstream = {
      ...effective.upstream,
      messages: [{ role: 'user', content: CHAT_PROBE_PING }],
    };
  }

  // ── SPI wiring: reach-tracked http + probe-bounded budget. ─────────────────
  const tracker = reachTracking(deps.http);
  const budgetSeconds = Math.min(
    PROBE_MAX_BUDGET_SECONDS,
    offering.timeoutBudgetSeconds ?? PROBE_MAX_BUDGET_SECONDS,
    model.maxRunTimeSeconds ?? PROBE_MAX_BUDGET_SECONDS,
  );
  const proxyUrl =
    channel.proxyRef !== null && deps.resolveProxyUrl !== undefined
      ? await deps.resolveProxyUrl(channel.proxyRef)
      : undefined;
  const pipeline: PipelineDeps = {
    http: tracker.http,
    budget: { totalTimeoutMs: budgetSeconds * 1000 },
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
  };
  const syncInput: SyncRunInput = {
    operation: primaryOp,
    upstreamModelName: offering.upstreamModelName,
    params: effective,
    secret,
    ctx,
  };

  // ── dispatch by the offering's fetch mode (§3 — the probe follows how the
  //    upstream ACTUALLY delivers, exactly like the planner would). ──────────
  switch (offering.fetchProfile.mode) {
    case 'direct': {
      const run = await runSync(resolved.dialect, syncInput, pipeline);
      if (!run.ok) return completed(classify(run.error, tracker.reached()));
      return completed(verdictFromOutput(primaryOp, run.output));
    }
    case 'stream': {
      const handle = runStream(resolved.dialect, syncInput, pipeline);
      const first = await handle.firstFrame;
      if (first.kind === 'error') return completed(classify(first.error, tracker.reached()));
      let text = '';
      for await (const frame of handle.frames) {
        if (frame.kind === 'delta' && typeof frame.payload === 'string') text += frame.payload;
        if (frame.kind === 'error') return completed(classify(frame.error, true));
        if (frame.kind === 'done') break;
      }
      return completed(verdictFromOutput(primaryOp, text.length > 0 ? text : null));
    }
    case 'submit_poll':
    case 'submit_callback': {
      // 短样有界轮询 — the probe NEVER waits for a callback (a probe is a pull).
      const submit = await runTaskSubmit(resolved.dialect, syncInput, pipeline);
      if (!submit.ok) return completed(classify(submit.error, tracker.reached()));
      if (submit.kind === 'inline') return completed(verdictFromOutput(primaryOp, submit.output));
      const connectivity = pass('submit accepted by upstream');
      const probe = { upstreamTaskId: submit.upstreamTaskId, secret, ctx };
      const sleep =
        deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
      const intervalMs = deps.pollIntervalMs ?? PROBE_POLL_INTERVAL_MS;
      const deadline = startedAt + budgetSeconds * 1000;
      const maxPolls = Math.max(1, Math.ceil((budgetSeconds * 1000) / intervalMs));
      for (let poll = 0; poll < maxPolls && nowMs() < deadline; poll++) {
        await sleep(Math.min(intervalMs, Math.max(0, deadline - nowMs())));
        const update = await runTaskQuery(resolved.dialect, probe, pipeline);
        if (!update.ok) continue; // poll 单次失败不一错即败 (§3) — the budget bounds the loop.
        const u = update.update;
        if (u.status === 'succeeded') {
          return completed({ ...verdictFromOutput(primaryOp, u.output ?? null), connectivity });
        }
        if (u.status === 'failed' || u.status === 'canceled' || u.status === 'expired') {
          const err = u.error;
          return completed({
            connectivity,
            functional: fail(err?.message ?? `upstream task ended '${u.status}'`, err?.code),
          });
        }
      }
      return completed({
        connectivity,
        functional: fail(
          `upstream task did not reach a terminal state within ${String(budgetSeconds)}s`,
          'upstream_timeout',
        ),
      });
    }
  }
}
