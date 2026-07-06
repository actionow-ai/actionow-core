import type { AdapterRegistry } from '@actionow/adapters';
import { routeWithFailover } from '@actionow/adapters';
import type {
  AdapterContext,
  CallbackResult,
  ExecMode,
  HttpClient,
  MediaResult,
  Modifier,
  PollResult,
  PricebookEntry,
  UnifiedError,
  UpstreamJobHandle,
  UsageVector,
} from '@actionow/contracts';
import {
  type DbOrTx,
  failJob,
  getJob,
  getJobByUpstreamHandle,
  insertRelayTrace,
  type Job,
  settleJob,
  setUpstreamHandle,
  transitionJob,
} from '@actionow/db';

import type { BreakerStore } from './breaker.js';
import { isFailoverRetryable } from './channel-routing.js';
import { EngineError } from './errors.js';
import type { RunChannel } from './execution-service.js';
import type { JobProgressEvent } from './job-progress.js';
import { meterMedia, type PersistedMediaObject, PersistRequiredError } from './media-result.js';
import { serializeAppliedModifiers, settledCost } from './pricing.js';
import { type TraceContext, TracingHttpClient } from './relay-trace.js';

/** Default per-body byte cap when the runner deps carry no `traceMaxBytes`. */
const DEFAULT_TRACE_MAX_BYTES = 1_000_000;

/**
 * The frozen execution context a {@link JobRunner} needs to drive a job that
 * was already held + persisted. Loaded from the job snapshot + catalog by an
 * injected {@link ExecutionContextLoader} (the api/worker owns the SQL).
 */
export interface JobExecutionContext {
  /** The account whose hold is settled/released (resolved by the loader). */
  accountId: string;
  providerType: string;
  modality: string;
  pricebookEntry: PricebookEntry;
  modifiers: Modifier[];
  channels: RunChannel[];
}

export type ExecutionContextLoader = (job: Job) => Promise<JobExecutionContext>;

/**
 * Persist a canonical {@link MediaResult}'s assets to durable storage (P1),
 * returning the rewritten result (durable URLs) + the persisted objects (one
 * `file_object` per object, written by the caller). Best-effort: never throws.
 */
export type PersistMediaResultFn = (input: {
  tenantId: string;
  jobId: string;
  result: MediaResult;
  /**
   * When true, persistence is required: the fn throws {@link PersistRequiredError}
   * (instead of falling back to the upstream URL) if the asset can't be persisted,
   * so the settle path fails the job + releases the hold. Default false.
   */
  requirePersist?: boolean;
}) => Promise<{ result: MediaResult; objects: PersistedMediaObject[] }>;

/** A per-call `usage_log` row for a settled media job (P1 metering / margin). */
export interface MediaUsageLogRow {
  tenantId: string;
  model: string;
  cost: bigint;
  providerCost?: bigint | undefined;
  status: 'succeeded' | 'failed';
  channelId?: string | undefined;
  providerType?: string | undefined;
}
export type InsertMediaUsageLogFn = (row: MediaUsageLogRow) => Promise<void>;

export interface JobRunnerDeps {
  db: DbOrTx;
  adapters: AdapterRegistry;
  loadContext: ExecutionContextLoader;
  resolveSecret: (ref: string) => Promise<string | undefined>;
  http: HttpClient;
  /** Max poll iterations before timing out (default 30). */
  maxPolls?: number;
  /** Delay between polls in ms (default 1000). */
  pollIntervalMs?: number;
  /** Injectable sleep so tests run without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Source of randomness for weighted channel selection (default Math.random). */
  rng?: () => number;
  /** Global egress proxy fallback (UPSTREAM_PROXY_URL) when a channel has no proxyRef. */
  proxyUrlEnv?: string | undefined;
  /**
   * The per-`(channel, model)` circuit breaker (弹性2.0). When injected, the
   * async submit path excludes Open channels + trial-gates HalfOpen ones before
   * the cross-channel failover and feeds each submit outcome to the FSM
   * (`onSuccess` on a returned handle, `onFailure` on a retryable failure).
   * Fail-open + fire-and-forget inside the store, so it only OPTIMIZES the
   * async/media routing — a breaker outage never fails a job that could have
   * succeeded. Absent → routing is unchanged.
   */
  breaker?: BreakerStore | undefined;
  /** Persist a canonical MediaResult's assets before settle (P1). */
  persistMediaResult?: PersistMediaResultFn | undefined;
  /** Write a usage_log row for a settled media job (P1 metering — media margin visibility). */
  insertUsageLog?: InsertMediaUsageLogFn | undefined;
  /**
   * When true (`RELAY_TRACE=full`), wrap `ctx.http` in a {@link TracingHttpClient}
   * so the async media submit/poll upstream calls are captured to `relay_trace`
   * (best-effort; secrets redacted; bodies capped). Default off.
   */
  traceUpstream?: boolean | undefined;
  /** Per-body byte cap for the trace (RELAY_TRACE_MAX_BYTES). Default 1MB. */
  traceMaxBytes?: number | undefined;
  /**
   * Fire-and-forget progress sink for the SSE endpoint (`GET /v1/jobs/:id/stream`).
   * Called at lifecycle milestones (running/polling/succeeded/failed). BEST-EFFORT
   * by contract: every call is wrapped in a try/catch swallow and never awaited,
   * so a throwing/slow publisher (e.g. a Redis blip) CANNOT fail or stall a job.
   * The SSE service's DB-poll backstop guarantees terminal delivery regardless.
   * Absent (e.g. a fake test runtime) → no-op.
   */
  publishProgress?: ((jobId: string, event: JobProgressEvent) => void) | undefined;
}

const DEFAULT_MAX_POLLS = 30;
const DEFAULT_POLL_INTERVAL_MS = 1000;
/** Min gap between throttled `polling` progress publishes (~1 every 2s). */
const PROGRESS_POLL_THROTTLE_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a channel-config value as an integer ≥ `min`, or undefined when absent/invalid. */
function asIntAtLeast(value: unknown, min: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;
}

/**
 * Narrow a channel-config `costPerUnit` (e.g. `{ images: 1500, duration_seconds: 200 }`,
 * µUSD per output unit) to a clean number-valued record, dropping non-number
 * entries. Returns undefined when absent/invalid → an unknown (NULL) provider_cost.
 */
function asCostPerUnit(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Drives an async job from `queued` to a terminal state (§4.1.7 async branch):
 * `transitionJob(queued→running)` → `adapter.submit` (async handle) → bounded
 * `adapter.poll` loop → `settleJob`/`failJob`. Settle/fail run on the root db
 * so they keep their own atomic transaction and their own dedup guard, which
 * makes a poll/callback race converge to exactly one ledger row.
 */
export class JobRunner {
  private readonly deps: JobRunnerDeps;

  constructor(deps: JobRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Publish a progress milestone — FIRE-AND-FORGET. Never awaited, and any throw
   * (a synchronous one from the injected publisher) is swallowed: a progress
   * publish must NEVER fail or slow the job. The SSE service's DB-poll backstop
   * makes correctness independent of whether this delivers. No-op when no
   * publisher is injected.
   */
  private emitProgress(jobId: string, event: JobProgressEvent): void {
    const publish = this.deps.publishProgress;
    if (publish === undefined) return;
    try {
      publish(jobId, event);
    } catch {
      // Best-effort: progress is an optimization, never the source of truth.
    }
  }

  /** Execute a queued job to terminal state. Idempotent if already terminal. */
  async process(jobId: string): Promise<void> {
    const { db } = this.deps;
    const job = await getJob(db, jobId);
    if (job === undefined) {
      throw new EngineError({
        code: 'resource_not_found',
        message: `job ${jobId} not found`,
        retryable: false,
      });
    }

    // Guard: only a queued job may start running. A second processor (or a
    // replay) finds it non-queued and no-ops.
    const started = await transitionJob(db, jobId, ['queued'], 'running');
    if (!started) return;

    // Milestone: the job is now running (submitted to the upstream next). Best-
    // effort SSE progress; never blocks the run.
    this.emitProgress(jobId, { status: 'running', phase: 'submitted' });

    const ctx = await this.deps.loadContext(job);
    const handle = await this.submit(job, ctx);
    await setUpstreamHandle(db, jobId, handle.upstreamJobId);
    await this.pollToTerminal(job, ctx, handle);
  }

  /**
   * Terminal-fail a job whose queue delivery exhausted its retry budget: release
   * the hold + mark the row `failed` NOW, rather than leaving it `running` (the
   * state `process` flips it to before a throw) with credits held until the
   * ~15-min reaper. No-op when the job is already terminal or vanished — so it is
   * safe to call from a BullMQ `failed` handler. Dedup-safe via failJob's
   * status-transition guard.
   */
  async failExhausted(jobId: string, message: string): Promise<void> {
    const job = await getJob(this.deps.db, jobId);
    if (job === undefined) return;
    if (job.status !== 'queued' && job.status !== 'running') return;
    const ctx = await this.deps.loadContext(job);
    await this.fail(job, ctx, { code: 'internal_error', message, retryable: false });
  }

  /** Submit to the upstream provider; a synchronous result is unexpected here. */
  private async submit(job: Job, ctx: JobExecutionContext): Promise<UpstreamJobHandle> {
    const adapter = this.deps.adapters.get(ctx.providerType);
    const rng = this.deps.rng ?? Math.random;
    const breaker = this.deps.breaker;
    // The model the breaker keys `(channel, model)` on. Async/media jobs carry
    // their model on the channel snapshot (one model per channel for media);
    // `'*'` for model-less resources, matching the blocking/stream paths.
    const model = ctx.channels[0]?.model ?? '*';
    // Breaker-aware candidate filtering before the cross-channel failover: drop
    // Open `(channel, model)` and trial-gate HalfOpen ones (fail-open internally,
    // so an evaluation error yields the full set). Absent breaker → unchanged.
    const candidates =
      breaker === undefined
        ? ctx.channels
        : await breaker.filterAvailable(ctx.channels, model, new Date());
    const result = await routeWithFailover(
      (candidates.length > 0 ? candidates : ctx.channels).map((c) => ({
        id: c.id,
        weight: c.weight,
        value: c,
      })),
      rng,
      async (channel) => {
        const adapterCtx = await this.buildContext(ctx.providerType, channel, job);
        try {
          const submitted = await adapter.submit({
            resourceId: job.resourceId,
            modality: ctx.modality,
            inputs: job.inputs,
            execMode: job.execMode as ExecMode,
            ctx: adapterCtx,
          });
          // The upstream accepted the submit (an async handle returned): feed
          // the breaker's success path (fire-and-forget; the store swallows).
          if (breaker !== undefined) void breaker.onSuccess(channel.id, model, new Date());
          return submitted;
        } catch (err) {
          // A RETRYABLE submit failure cools this `(channel, model)` down so the
          // next async job's pre-route filter can skip it. Non-retryable (bad
          // input / auth) is the caller's fault, not the channel's — not recorded.
          if (breaker !== undefined && isFailoverRetryable(err)) {
            void breaker.onFailure(channel.id, model, new Date());
          }
          throw err;
        }
      },
      // Use the SAME failover verdict as the breaker line above (and as the
      // blocking/stream paths): a raw transport throw (ECONNRESET/DNS/AbortError,
      // never an AdapterError) or a retryable EngineError must cascade to the next
      // channel — not hard-fail the whole job on one dead channel. The old
      // `isRetryableAdapterError` returned false for both, so the breaker cooled
      // the channel while the router refused to fail over.
      isFailoverRetryable,
    );
    if (result.kind !== 'async') {
      throw new EngineError({
        code: 'internal_error',
        message: 'async runner received a synchronous result',
        retryable: false,
      });
    }
    return result;
  }

  /** Bounded poll loop until the upstream job reaches a terminal status. */
  private async pollToTerminal(
    job: Job,
    ctx: JobExecutionContext,
    handle: UpstreamJobHandle,
  ): Promise<void> {
    const adapter = this.deps.adapters.get(ctx.providerType);
    if (adapter.poll === undefined) {
      throw new EngineError({
        code: 'internal_error',
        message: `adapter ${ctx.providerType} cannot poll`,
        retryable: false,
      });
    }
    // Per-channel poll budget (long-running media): a channel's `config` may raise
    // maxPolls/pollIntervalMs (e.g. a multi-minute video relay) above the runner's
    // deps default, so a slow job polls to completion instead of timing out at the
    // ~30s default. Falls back to the deps value, then the hardcoded default.
    const cfg = ctx.channels[0]?.config;
    const maxPolls = asIntAtLeast(cfg?.maxPolls, 1) ?? this.deps.maxPolls ?? DEFAULT_MAX_POLLS;
    const intervalMs =
      asIntAtLeast(cfg?.pollIntervalMs, 0) ?? this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = this.deps.sleep ?? defaultSleep;
    const adapterCtx = await this.buildContext(ctx.providerType, ctx.channels[0], job);

    // Throttle `polling` progress to ~1 every 2s so a tight poll loop (interval 0
    // in tests, or a sub-second media poll) does not flood the pub/sub channel.
    let lastProgressAt = 0;
    for (let i = 0; i < maxPolls; i += 1) {
      const result = await adapter.poll(handle.upstreamJobId, adapterCtx);
      if (result.status === 'succeeded') {
        await this.settle(job, ctx, result);
        // Milestone: terminal success (after the settle persist).
        this.emitProgress(job.id, { status: 'succeeded' });
        return;
      }
      if (result.status === 'failed') {
        await this.fail(job, ctx, result.error);
        // Milestone: terminal failure.
        this.emitProgress(job.id, { status: 'failed' });
        return;
      }
      // Still running: a throttled `polling` heartbeat.
      const now = Date.now();
      if (now - lastProgressAt >= PROGRESS_POLL_THROTTLE_MS) {
        lastProgressAt = now;
        this.emitProgress(job.id, { status: 'running', phase: 'polling', poll: i });
      }
      await sleep(intervalMs);
    }

    // Exhausted the poll budget without a terminal status: time out + release.
    await this.fail(job, ctx, {
      code: 'upstream_timeout',
      message: 'poll budget exhausted',
      retryable: true,
    });
    // Milestone: terminal failure (timeout).
    this.emitProgress(job.id, { status: 'failed' });
  }

  /**
   * Settle a finished upstream job. Dedup-safe: `settleJob` guards on the job
   * status transition, so a poll/callback double-settle yields one ledger row.
   */
  async settle(
    job: Job,
    ctx: JobExecutionContext,
    result: PollResult,
  ): Promise<{ settled: boolean }> {
    const usage: UsageVector = result.usage ?? {};
    let output = result.output ?? {};
    const isMedia = result.mediaResult !== undefined;
    // Best-effort media persistence BEFORE the settle write: persist the canonical
    // MediaResult's assets to durable storage and store the rewritten result as
    // `output`. Absent dep (non-media setups / tests) → output unchanged. The hook
    // never throws (falls back to the temp upstream URL); settle proceeds regardless.
    if (result.mediaResult !== undefined && this.deps.persistMediaResult !== undefined) {
      try {
        const persisted = await this.deps.persistMediaResult({
          tenantId: job.tenantId,
          jobId: job.id,
          result: result.mediaResult,
          requirePersist: job.requirePersist,
        });
        output = persisted.result;
      } catch (err) {
        // require_persist (compliance/watermark switch): persistence was mandatory
        // and failed → FAIL the job (releasing the hold, no charge) BEFORE any
        // settle write, instead of settling on the transient upstream URL. Only
        // PersistRequiredError diverts; any other error preserves prior behavior.
        if (err instanceof PersistRequiredError) {
          return this.fail(job, ctx, {
            code: 'job_failed',
            message: err.message,
            retryable: false,
          });
        }
        throw err;
      }
    } else if (result.mediaResult !== undefined && job.requirePersist) {
      // require_persist was set but no persister is wired (object storage
      // unconfigured) → cannot guarantee persistence, so fail rather than settle
      // on the upstream URL.
      return this.fail(job, ctx, {
        code: 'job_failed',
        message:
          'media persistence is required (require_persist) but object storage is not configured',
        retryable: false,
      });
    }
    // Cost is computed from `usage` + `job.inputs`, so rewriting `output` does
    // not affect pricing. Capped at the placed hold (shared policy) so a media
    // async run can never settle above its (balance-gated) reservation.
    const { credits: finalCost, applied } = settledCost(
      ctx.pricebookEntry,
      usage,
      job.inputs,
      ctx.modifiers,
      job.quotedCredits ?? 0n,
    );
    const settleResult = await settleJob(this.deps.db, {
      jobId: job.id,
      accountId: ctx.accountId,
      tenantId: job.tenantId,
      subjectId: job.subjectId,
      holdAmount: job.quotedCredits ?? 0n,
      finalCost,
      usage,
      output,
      pricebookVersion: ctx.pricebookEntry.version,
      modifiersApplied: serializeAppliedModifiers(applied),
      resourceId: job.resourceId,
      ...(job.callbackUrl !== null
        ? { outbox: { url: job.callbackUrl, payload: { job_id: job.id } } }
        : {}),
    });
    // P1 metering: write ONE usage_log row for a freshly-settled media job so
    // media cost/margin is no longer invisible to the admin rollup. Guard on
    // `settled` so a poll/callback double-settle does not double-count. Cost is
    // the customer µcredit charge; provider_cost = Σ usage[dim] × channel
    // costPerUnit[dim] (µUSD), NULL when the channel has no per-unit cost.
    if (settleResult.settled && isMedia && this.deps.insertUsageLog !== undefined) {
      const channel = ctx.channels[0];
      const providerCost = meterMedia(usage, asCostPerUnit(channel?.config?.costPerUnit));
      await this.deps.insertUsageLog({
        tenantId: job.tenantId,
        model: channel?.model ?? job.resourceId,
        cost: finalCost,
        ...(providerCost !== undefined ? { providerCost } : {}),
        status: 'succeeded',
        ...(channel?.id !== undefined ? { channelId: channel.id } : {}),
        providerType: ctx.providerType,
      });
    }
    return settleResult;
  }

  /** Fail/release a job. Dedup-safe via the same status-transition guard. */
  async fail(
    job: Job,
    ctx: JobExecutionContext,
    error?: UnifiedError,
  ): Promise<{ settled: boolean }> {
    return failJob(this.deps.db, {
      jobId: job.id,
      accountId: ctx.accountId,
      tenantId: job.tenantId,
      subjectId: job.subjectId,
      holdAmount: job.quotedCredits ?? 0n,
      to: 'failed',
      error: error ?? null,
      ...(job.callbackUrl !== null
        ? { outbox: { url: job.callbackUrl, payload: { job_id: job.id, error } } }
        : {}),
    });
  }

  /**
   * Handle an upstream callback for an async-callback job: parse the payload,
   * correlate it to the job by its upstream handle, load the context, and
   * settle/fail. Dedup-safe even if the poll loop also fired (settle's guard
   * converges both to one ledger row).
   */
  async handleCallback(payload: unknown): Promise<{ settled: boolean }> {
    const parsed = this.parseCallback(payload);
    if (parsed === undefined) return { settled: false };

    const job = await getJobByUpstreamHandle(this.deps.db, parsed.upstreamJobId);
    if (job === undefined) return { settled: false };

    const ctx = await this.deps.loadContext(job);
    if (parsed.status === 'succeeded') {
      return this.settle(job, ctx, parsed);
    }
    return this.fail(job, ctx, parsed.error);
  }

  /** Find the first registered adapter that recognizes this callback payload. */
  private parseCallback(payload: unknown): CallbackResult | undefined {
    for (const providerType of this.deps.adapters.providerTypes()) {
      const adapter = this.deps.adapters.get(providerType);
      if (adapter.parseCallback === undefined) continue;
      try {
        const parsed = adapter.parseCallback(payload);
        if (parsed.upstreamJobId !== '') return parsed;
      } catch {
        // Not this adapter's payload shape — try the next.
      }
    }
    return undefined;
  }

  private async buildContext(
    providerType: string,
    channel: RunChannel | undefined,
    job: Job,
  ): Promise<AdapterContext> {
    const ctx: AdapterContext = {
      providerType,
      http: this.maybeTrace({
        tenantId: job.tenantId,
        jobId: job.id,
        providerType,
        ...(channel !== undefined ? { channelId: channel.id } : {}),
      }),
    };
    if (channel === undefined) {
      // No channel: the global egress proxy fallback still applies.
      if (this.deps.proxyUrlEnv !== undefined) ctx.proxyUrl = this.deps.proxyUrlEnv;
      return ctx;
    }
    if (channel.model !== undefined) ctx.model = channel.model;
    if (channel.endpoint !== undefined) ctx.endpoint = channel.endpoint;
    if (channel.credentialRef !== undefined) {
      const apiKey = await this.deps.resolveSecret(channel.credentialRef);
      if (apiKey !== undefined) ctx.apiKey = apiKey;
    }
    const proxyUrl = await this.resolveProxy(channel);
    if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;
    if (channel.config !== undefined) ctx.config = channel.config;
    // Plugin-served channel (P2): attach the frozen snapshot + the resolved
    // credential map (consumed only by the signer OUTSIDE the sandbox).
    if (channel.plugin !== undefined) {
      ctx.plugin = channel.plugin;
      ctx.credentials = await this.resolvePluginCredentials(channel);
    }
    return ctx;
  }

  /**
   * Assemble a plugin's credential map: non-secret fields from the channel
   * `config` (region/service/header_name/…) overlaid with the secret(s) from
   * `credentialRef` — which resolves to either a JSON object (multi-secret, e.g.
   * `{ak, sk}`) or a bare string (treated as `api_key`). Secrets live ONLY here.
   */
  private async resolvePluginCredentials(channel: RunChannel): Promise<Record<string, string>> {
    const cred: Record<string, string> = {};
    if (channel.config !== undefined) {
      for (const [k, v] of Object.entries(channel.config)) if (typeof v === 'string') cred[k] = v;
    }
    if (channel.credentialRef !== undefined) {
      const secret = await this.deps.resolveSecret(channel.credentialRef);
      if (secret !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(secret);
        } catch {
          parsed = undefined;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string') cred[k] = v;
          }
        } else {
          cred.api_key = secret;
        }
      }
    }
    return cred;
  }

  /** Resolve a channel's egress proxy URL: its proxyRef (via resolveSecret), else the global env fallback. */
  private async resolveProxy(channel: RunChannel): Promise<string | undefined> {
    if (channel.proxyRef !== undefined) {
      const url = await this.deps.resolveSecret(channel.proxyRef);
      if (url !== undefined) return url;
    }
    return this.deps.proxyUrlEnv;
  }

  /**
   * Wrap the shared `http` in a {@link TracingHttpClient} when tracing is on,
   * else return it unwrapped. Best-effort `insertRelayTrace` sink.
   */
  private maybeTrace(trace: TraceContext): HttpClient {
    if (this.deps.traceUpstream !== true) return this.deps.http;
    const db = this.deps.db;
    return new TracingHttpClient(
      this.deps.http,
      async (row) => {
        await insertRelayTrace(db, row);
      },
      trace,
      this.deps.traceMaxBytes ?? DEFAULT_TRACE_MAX_BYTES,
    );
  }
}
