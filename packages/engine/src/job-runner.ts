import type { AdapterRegistry } from '@actionow/adapters';
import { isRetryableAdapterError, routeWithFailover } from '@actionow/adapters';
import type {
  AdapterContext,
  CallbackResult,
  ExecMode,
  HttpClient,
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

import { EngineError } from './errors.js';
import type { RunChannel } from './execution-service.js';
import type { PersistMediaResult } from './media-persistence.js';
import { computeFinalCost, serializeAppliedModifiers } from './pricing.js';
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
 * Persist media outputs to durable storage, returning a (possibly) rewritten
 * output. Optional injected dependency; absent → no rewrite. Best-effort: the
 * concrete hook never throws (it falls back to the temp upstream URL), so
 * settle proceeds regardless. Wired in Task 10 over a real StorageProvider.
 */
export type PersistMediaFn = (input: {
  tenantId: string;
  jobId: string;
  output: Record<string, unknown>;
}) => Promise<PersistMediaResult>;

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
  /** Persist media outputs before settle (rewrites temp upstream URLs to durable ones). */
  persistMedia?: PersistMediaFn | undefined;
  /**
   * When true (`RELAY_TRACE=full`), wrap `ctx.http` in a {@link TracingHttpClient}
   * so the async media submit/poll upstream calls are captured to `relay_trace`
   * (best-effort; secrets redacted; bodies capped). Default off.
   */
  traceUpstream?: boolean | undefined;
  /** Per-body byte cap for the trace (RELAY_TRACE_MAX_BYTES). Default 1MB. */
  traceMaxBytes?: number | undefined;
}

const DEFAULT_MAX_POLLS = 30;
const DEFAULT_POLL_INTERVAL_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const ctx = await this.deps.loadContext(job);
    const handle = await this.submit(job, ctx);
    await setUpstreamHandle(db, jobId, handle.upstreamJobId);
    await this.pollToTerminal(job, ctx, handle);
  }

  /** Submit to the upstream provider; a synchronous result is unexpected here. */
  private async submit(job: Job, ctx: JobExecutionContext): Promise<UpstreamJobHandle> {
    const adapter = this.deps.adapters.get(ctx.providerType);
    const rng = this.deps.rng ?? Math.random;
    const result = await routeWithFailover(
      ctx.channels.map((c) => ({ id: c.id, weight: c.weight, value: c })),
      rng,
      async (channel) => {
        const adapterCtx = await this.buildContext(ctx.providerType, channel, job);
        return adapter.submit({
          resourceId: job.resourceId,
          modality: ctx.modality,
          inputs: job.inputs,
          execMode: job.execMode as ExecMode,
          ctx: adapterCtx,
        });
      },
      isRetryableAdapterError,
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
    const maxPolls = this.deps.maxPolls ?? DEFAULT_MAX_POLLS;
    const intervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = this.deps.sleep ?? defaultSleep;
    const adapterCtx = await this.buildContext(ctx.providerType, ctx.channels[0], job);

    for (let i = 0; i < maxPolls; i += 1) {
      const result = await adapter.poll(handle.upstreamJobId, adapterCtx);
      if (result.status === 'succeeded') {
        await this.settle(job, ctx, result);
        return;
      }
      if (result.status === 'failed') {
        await this.fail(job, ctx, result.error);
        return;
      }
      await sleep(intervalMs);
    }

    // Exhausted the poll budget without a terminal status: time out + release.
    await this.fail(job, ctx, {
      code: 'upstream_timeout',
      message: 'poll budget exhausted',
      retryable: true,
    });
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
    // Best-effort media persistence: rewrite temp upstream media URLs to durable
    // ones BEFORE the settle write. Absent (non-media setups / existing tests) →
    // unchanged. The hook never throws (Task 8); settle proceeds regardless.
    if (this.deps.persistMedia !== undefined) {
      const persisted = await this.deps.persistMedia({
        tenantId: job.tenantId,
        jobId: job.id,
        output,
      });
      output = persisted.output;
    }
    // Cost is computed from `usage` + `job.inputs`, so rewriting `output` does
    // not affect pricing.
    const { credits: finalCost, applied } = computeFinalCost(
      ctx.pricebookEntry,
      usage,
      job.inputs,
      ctx.modifiers,
    );
    return settleJob(this.deps.db, {
      jobId: job.id,
      accountId: ctx.accountId,
      tenantId: job.tenantId,
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
    return ctx;
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
