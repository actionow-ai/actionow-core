import type { AdapterRegistry } from '@actionow/adapters';
import { orderForFailover } from '@actionow/adapters';
import type {
  AdapterContext,
  ChatRequest,
  ChatStreamEvent,
  HttpClient,
  StreamEvent,
  SubmitInput,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { type DbOrTx, failJob, insertRelayTrace, insertUsageLog, settleJob } from '@actionow/db';
import { type MicroCredits, priceProviderCost } from '@actionow/domain';

import type { BreakerStore } from './breaker.js';
import { availableChannels, isFailoverRetryable } from './channel-routing.js';
import { EngineError } from './errors.js';
import type { RunChannel, RunRequest } from './execution-service.js';
import { wrapHttpWithTimeouts } from './fault-policy.js';
import { computeFinalCost, serializeAppliedModifiers } from './pricing.js';
import { type TraceContext, TracingHttpClient } from './relay-trace.js';

/** Default per-body byte cap when the stream deps carry no `traceMaxBytes`. */
const DEFAULT_TRACE_MAX_BYTES = 1_000_000;

/** Everything the settling stream generator needs, frozen at hold time. */
export interface SettlingStreamDeps {
  db: DbOrTx;
  adapters: AdapterRegistry;
  resolveSecret: (ref: string) => Promise<string | undefined>;
  http: HttpClient;
  /** The persisted job id this stream settles. */
  jobId: string;
  /** The validated run inputs (already schema-checked). */
  inputs: Record<string, unknown>;
  /** The modifier-adjusted hold placed before the stream started. */
  holdAmount: MicroCredits;
  /** The frozen run request (resource/pricing/channels/account). */
  req: RunRequest;
  /** Global egress proxy fallback (UPSTREAM_PROXY_URL) when a channel has no proxyRef. */
  proxyUrlEnv?: string | undefined;
  /** Clock for cooldown timestamps (chat channel failover); defaults to wall-clock. */
  now?: (() => Date) | undefined;
  /** RNG for weighted channel selection (chat channel failover); defaults to Math.random. */
  rng?: (() => number) | undefined;
  /**
   * The per-`(channel, model)` circuit breaker (弹性2.0). When injected, the
   * chat stream's pre-first-event channel selection excludes Open channels +
   * trial-gates HalfOpen ones, and each pre-commit outcome feeds the FSM
   * (`onFailure` on a retryable first-event failure, `onSuccess` once a channel
   * commits). Fail-open + fire-and-forget inside the store, so it only OPTIMIZES
   * the stream failover — a breaker outage never fails a stream that could have
   * served. Absent → selection is unchanged.
   */
  breaker?: BreakerStore | undefined;
  /** When true (`RELAY_TRACE=full`), wrap `ctx.http` in a {@link TracingHttpClient}. */
  traceUpstream?: boolean | undefined;
  /** Per-body byte cap for the trace (RELAY_TRACE_MAX_BYTES). Default 1MB. */
  traceMaxBytes?: number | undefined;
}

/**
 * Build the per-run async generator that proxies the adapter's stream to the
 * consumer and **settles exactly once** when the stream ends — on normal
 * completion, on an upstream/adapter error, AND on consumer early-`return()`
 * (a client disconnect / SSE unsubscribe; the generator's `finally` runs then).
 * The hold has already been placed and the job persisted by `runStream`; this
 * generator owns the terminal settle.
 *
 * Settle-once is enforced two ways: a local `settled` boolean guard, and — as
 * the backstop for any race — `settleJob`/`failJob`'s status-transition guard,
 * the same property the poll/callback paths rely on. The latest `usage` event
 * seen on the wire prices the final cost; an upstream `error` event (or a thrown
 * adapter) routes the terminal handling to `failJob` (release hold, no charge)
 * and re-throws so the consumer/transport sees the failure.
 *
 * On the normal-completion path the generator emits a terminal engine `done`
 * carrying `{jobId, usage, cost}` (cost.credits as a decimal-string µcredit
 * amount). On the disconnect path the consumer is already gone, so no `done` is
 * delivered — but the settle still runs in `finally`.
 */
export async function* createSettlingStream(deps: SettlingStreamDeps): AsyncGenerator<StreamEvent> {
  const adapter = deps.adapters.get(deps.req.resource.providerType);
  if (adapter.stream === undefined) {
    throw new EngineError({
      code: 'internal_error',
      message: `adapter ${deps.req.resource.providerType} cannot stream`,
      retryable: false,
    });
  }

  let latestUsage: UsageVector | undefined;
  let failure: UnifiedError | undefined;
  let settled = false;

  /**
   * Settle (success) or fail (release) exactly once. Returns the settled cost
   * on the success path so the caller can emit the terminal `done`; returns
   * `undefined` on the failure path or on a repeated (already-settled) call.
   */
  const finalize = async (): Promise<MicroCredits | undefined> => {
    if (settled) return undefined;
    settled = true;
    if (failure !== undefined) {
      await failStream(deps, failure);
      return undefined;
    }
    return settleStream(deps, latestUsage);
  };

  try {
    const ctx = await buildContext(deps, deps.req.channels[0]);
    const input: SubmitInput = {
      resourceId: deps.req.resource.id,
      modality: deps.req.resource.modality,
      inputs: deps.inputs,
      execMode: deps.req.execMode,
      ctx,
    };

    for await (const ev of adapter.stream(input, ctx)) {
      if ((ev.kind === 'usage' || ev.kind === 'done') && ev.usage !== undefined) {
        latestUsage = ev.usage;
      }
      if (ev.kind === 'error') {
        failure = ev.error ?? {
          code: 'upstream_error',
          message: 'upstream error',
          retryable: false,
        };
        throw new EngineError(failure);
      }
      // Forward delta/usage to the consumer; the engine emits its own terminal
      // `done` (with cost) after settle, so swallow the adapter's `done`.
      if (ev.kind !== 'done') yield ev;
    }

    // Normal completion: settle, then emit the engine's terminal `done`.
    const cost = await finalize();
    if (cost !== undefined) {
      yield {
        kind: 'done',
        jobId: deps.jobId,
        usage: latestUsage ?? {},
        cost: { credits: cost.toString() },
      };
    }
  } catch (err) {
    failure ??= toUnified(err);
    await finalize();
    throw err instanceof EngineError ? err : new EngineError(failure);
  } finally {
    // Backstop: a consumer that disconnected (early `return()`) never reached
    // the normal-completion settle above, so settle here. Idempotent via the
    // `settled` guard (+ the DB transition guard).
    await finalize();
  }
}

/**
 * A pre-committed chat stream: the LIVE channel was selected and its first event
 * already pulled, by {@link openChatStreamCommit}. Once this resolves the client
 * can begin receiving bytes — there is no more cross-channel failover; a later
 * (post-commit) error is handled in-band by {@link createChatSettlingStream}.
 */
export interface CommittedChatStream {
  /** The committed channel's IR stream, positioned AFTER the first event. */
  readonly iterator: AsyncIterator<ChatStreamEvent>;
  /** The first event already pulled (undefined for an empty stream). */
  readonly first: ChatStreamEvent | undefined;
  /** The channel whose stream committed (its first event was non-error). */
  readonly servedChannel: RunChannel;
}

/**
 * Phase 1 of an IR chat stream — pick a LIVE channel and pull the first event,
 * with **breaker-aware cross-channel pre-commit failover**. We may switch
 * channels ONLY before any frame is forwarded: a retryable first-event error
 * (or a thrown connection) cools that `(channel, model)` and advances to the
 * next; the injected breaker excludes Open channels + trial-gates HalfOpen ones
 * (fail-open internally) and each pre-commit outcome feeds the FSM
 * (`onFailure`/`onSuccess`). Once a channel yields a non-error first event (or
 * an empty `first.done`), it is **committed** and returned as a
 * {@link CommittedChatStream}.
 *
 * On all-channels-exhausted / a non-retryable first error / no streamable
 * channel it **THROWS** an {@link EngineError} that PRESERVES the underlying
 * unified `code`/`retryable`. The caller ({@link ExecutionService.runChatStream})
 * releases the hold and rethrows so the throw becomes a real HTTP error
 * (pre-flush, before the SSE headers are committed) OR drives the relay's model
 * fallback — which degrades only on retryable DEGRADE_CODES, so a non-retryable
 * first error (kept `retryable:false`) never degrades.
 *
 * Awaiting this (rather than yielding Phase 1 lazily as the old combined
 * generator did) is the whole point of ⑤-S: the first good event is in hand
 * BEFORE the controller flushes SSE headers, so a total pre-commit failure can
 * still surface as an HTTP status / a cross-model fallback instead of a
 * `200` + in-band error frame.
 */
export async function openChatStreamCommit(deps: SettlingStreamDeps): Promise<CommittedChatStream> {
  const ir = deps.inputs.__ir as ChatRequest | undefined;
  if (ir === undefined) {
    throw new EngineError({
      code: 'internal_error',
      message: 'chat settling stream requires an IR ChatRequest at inputs.__ir',
      retryable: false,
    });
  }

  const rng = deps.rng ?? Math.random;
  const now = deps.now ?? ((): Date => new Date());
  const model = deps.req.usageLogModel ?? '*';
  // Feed the breaker's write path on a pre-first-event channel failure: a
  // retryable error (or a thrown connection) before the stream committed cools
  // that `(channel, model)` down so the next pre-commit pick can skip it. Like
  // the blocking `routeBlocking` outcome hooks, this is fire-and-forget — the
  // store already swallows errors, and `void` guarantees a breaker write can
  // never block or throw on the streaming hot path.
  const recordFailureSafe = (channelId: string): Promise<void> => {
    if (deps.breaker !== undefined) {
      void deps.breaker.onFailure(channelId, model, now());
    }
    return Promise.resolve();
  };
  // Feed the breaker's write path once a channel COMMITS (its first event was
  // non-error / the stream opened cleanly): the upstream connection succeeded,
  // so close a HalfOpen probe and count the success in the window. Fire-and-
  // forget like the failure hook. A later mid-stream (in-band) error is NOT a
  // connection failure of this channel, so it is not recorded here.
  const recordCommitSafe = (channelId: string): void => {
    if (deps.breaker !== undefined) void deps.breaker.onSuccess(channelId, model, now());
  };

  // Breaker-aware pre-first-event selection: the injected store excludes Open
  // `(channel, model)` and trial-gates HalfOpen ones (fail-open internally), so
  // the stream's pre-commit failover skips a tripped channel just like the
  // blocking path. Absent breaker → the full channel set (unchanged).
  const available = await availableChannels(
    { db: deps.db, now, rng, breaker: deps.breaker },
    deps.req.channels,
    model,
  );
  if (available.length === 0) {
    throw new EngineError({
      code: 'internal_error',
      message: 'no upstream channel to route to',
      retryable: false,
    });
  }
  // Carry each channel's group-membership `priority` (Track 4) into the failover
  // ordering so the pre-first-event stream failover is priority-tier-aware: the
  // highest tier is tried first, weighted within the tier, then the next-lower
  // tier. Absent `priority` → a single tier (legacy flat-weighted).
  const ordered = orderForFailover(
    available.map((c) => ({ id: c.id, weight: c.weight, priority: c.priority, value: c })),
    rng,
  );

  let lastError: UnifiedError | undefined;
  for (let i = 0; i < ordered.length; i += 1) {
    const channel = ordered[i]?.value;
    if (channel === undefined) continue;
    const isLast = i === ordered.length - 1;
    // Select the adapter PER CHANNEL so channels under one resource can target
    // different providers (cross-provider failover) — mirroring the blocking
    // `runChat` path. Falls back to the resource provider for single-provider
    // channels with no per-channel `providerType`.
    const adapter = deps.adapters.get(channel.providerType ?? deps.req.resource.providerType);
    if (adapter.streamChat === undefined) {
      // This channel's adapter cannot stream: record the failure and advance, or
      // throw a (non-retryable) error if this was the last channel.
      lastError = {
        code: 'internal_error',
        message: `adapter ${adapter.providerType} cannot streamChat`,
        retryable: false,
      };
      if (!isLast) continue;
      throw new EngineError(lastError);
    }
    const ctx = await buildContext(deps, channel);
    try {
      const iterator = adapter.streamChat(ir, ctx)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done === true) {
        // Empty stream (no frames): commit; the drain's `finally` settles a
        // measured 0.
        recordCommitSafe(channel.id);
        return { iterator, first: undefined, servedChannel: channel };
      }
      if (first.value.type === 'error') {
        const e = first.value.error;
        if (e.retryable && !isLast) {
          await recordFailureSafe(channel.id);
          lastError = e;
          continue;
        }
        // Non-retryable, or the last channel: THROW, preserving the underlying
        // code/retryable so the relay degrades only on retryable DEGRADE_CODES.
        throw new EngineError(e);
      }
      recordCommitSafe(channel.id);
      return { iterator, first: first.value, servedChannel: channel };
    } catch (err) {
      // A decided failure (a non-retryable EngineError we built above, or any
      // non-retryable carrier) is final — propagate it untouched.
      if (err instanceof EngineError && !err.unified.retryable) throw err;
      if (isFailoverRetryable(err) && !isLast) {
        await recordFailureSafe(channel.id);
        lastError = toUnified(err);
        continue;
      }
      throw err instanceof EngineError ? err : new EngineError(toUnified(err));
    }
  }

  // Every channel failed retryably and the list is exhausted: throw the LAST
  // channel's error (retryable), so the relay's model fallback fires.
  throw new EngineError(
    lastError ?? { code: 'upstream_error', message: 'all channels failed', retryable: false },
  );
}

/**
 * Phase 2 of an IR chat stream — DRAIN the pre-committed channel from
 * {@link openChatStreamCommit} and **settle exactly once**. Yields `committed.first`,
 * drains the rest of the iterator, forwards every IR {@link ChatStreamEvent}
 * verbatim (including the IR `done`), and on a POST-commit mid-stream `error`
 * event forwards it IN-BAND (→ fail/release + an in-band error frame, NOT a
 * throw — the SSE headers are already committed) before ending. Settle-once runs
 * in `finally` via the SAME `settleStream`/`failStream` helpers — on normal
 * completion, on an in-band error, AND on consumer early-`return()` (disconnect).
 * A no-usage end settles a measured partial, never the full hold (see below).
 *
 * Cross-channel pre-commit failover is NOT here anymore — it moved into the
 * awaited {@link openChatStreamCommit}; the single committing channel drains
 * byte-for-byte as before. `servedChannel` is sourced from `committed`.
 *
 * Boundary mapping (CRITICAL): the IR `usage` event carries camelCase
 * `{inputTokens, outputTokens}`, but the engine `UsageVector` / `computeFinalCost`
 * / `priceModelToken` read snake_case. So the captured usage is mapped to
 * `{ input_tokens, output_tokens }` before it crosses into the settle path — no
 * camelCase token field ever reaches a `UsageVector`.
 *
 * After a successful settle, a best-effort `usage_log` mirror fires when
 * `req.usageLogModel` is set (snake_case usage), matching `ExecutionService`'s
 * `settleSync` mirror so a streamed chat logs usage just like the sync path. A
 * log-insert failure never fails the settle (the ledger settle is the truth).
 *
 * The IR `done` shape is NOT mutated; the API reads the settled `jobId` from the
 * `ChatStreamOutcome.jobId` `runChatStream` returns (known before streaming).
 */
export async function* createChatSettlingStream(
  deps: SettlingStreamDeps,
  committed: CommittedChatStream,
): AsyncGenerator<ChatStreamEvent> {
  const ir = deps.inputs.__ir as ChatRequest | undefined;
  if (ir === undefined) {
    throw new EngineError({
      code: 'internal_error',
      message: 'chat settling stream requires an IR ChatRequest at inputs.__ir',
      retryable: false,
    });
  }

  let latestUsage: UsageVector | undefined;
  let failure: UnifiedError | undefined;
  let settled = false;
  // The channel whose stream committed (its first event was non-error), threaded
  // into the usage_log mirror so a streamed chat records which channel/provider
  // ultimately served — matching the blocking `runChat` path (cross-provider).
  const servedChannel = committed.servedChannel;
  // Output bytes actually streamed to the consumer. When a stream ends WITHOUT a
  // usage frame — a clean disconnect BEFORE the trailing usage event (every real
  // adapter emits usage last), or a provider that never reports usage — this
  // measures the partial work so the settle charges it rather than the gross
  // over-hold ceiling (the streaming hold is a deliberately generous estimate;
  // charging it on a no-usage abort would over-bill by orders of magnitude).
  let streamedChars = 0;

  /**
   * Usage to settle on a clean end with NO usage frame: input estimated from the
   * request prompt, output from the bytes actually streamed (≈4 bytes/token).
   * Fair for a partial/aborted stream and abuse-resistant (a client that aborts
   * just before the trailing usage frame is still billed for what it received),
   * and always ≤ the hold ceiling so the settle cap never clamps it.
   */
  const measuredUsage = (): UsageVector => ({
    input_tokens: Math.ceil(JSON.stringify(ir.messages).length / 4),
    output_tokens: Math.ceil(streamedChars / 4),
  });

  /**
   * Settle (success) or fail (release) exactly once, then — on the success path
   * with a configured model — mirror the `usage_log` row (best-effort). When no
   * usage frame arrived, settle the {@link measuredUsage} partial, never `undefined`
   * (which would fall to `settleStream`'s charge-the-full-hold branch).
   */
  const finalize = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    if (failure !== undefined) {
      await failStream(deps, failure);
      return;
    }
    const usage = latestUsage ?? measuredUsage();
    const finalCost = await settleStream(deps, usage);
    await mirrorChatUsageLog(deps, usage, finalCost, {
      channelId: servedChannel.id,
      providerType: servedChannel.providerType ?? deps.req.resource.providerType,
      inputCostPer1m: servedChannel.inputCostPer1m,
      outputCostPer1m: servedChannel.outputCostPer1m,
    });
  };

  try {
    // Drain the committed channel (the first event, then the rest), tallying
    // usage/streamed-bytes and forwarding any mid-stream error in-band.
    const drain = async function* (): AsyncGenerator<ChatStreamEvent> {
      if (committed.first !== undefined) yield committed.first;
      for (;;) {
        const next = await committed.iterator.next();
        if (next.done === true) break;
        yield next.value;
      }
    };
    for await (const ev of drain()) {
      if (ev.type === 'usage') {
        // camelCase IR → snake_case engine UsageVector at the boundary.
        latestUsage = { input_tokens: ev.usage.inputTokens, output_tokens: ev.usage.outputTokens };
      }
      // Tally what the consumer actually received, for the no-usage settle.
      if (ev.type === 'content_delta') streamedChars += ev.text.length;
      if (ev.type === 'tool_call_delta' && ev.argumentsDelta !== undefined) {
        streamedChars += ev.argumentsDelta.length;
      }
      if (ev.type === 'error') {
        // Streaming has begun — the 200 + SSE headers are already committed, so a
        // throw can no longer become an HTTP error; it would only corrupt the
        // response framing and crash the global filter (ERR_HTTP_HEADERS_SENT).
        // Forward the IR error event so the dialect renderer emits an in-band
        // error frame, then end the stream; `finally` fails/releases the hold.
        failure = ev.error;
        yield ev;
        return;
      }
      // Forward every other IR event verbatim — including the IR `done`.
      yield ev;
    }
  } catch (err) {
    // A raw adapter throw (e.g. the upstream connection failed mid-drain).
    // Fail/release in `finally`, then surface the failure IN-BAND as an IR error
    // event rather than re-throwing into the already-committed SSE stream.
    const unified = failure ?? toUnified(err);
    failure = unified;
    await finalize();
    yield { type: 'error', error: unified };
  } finally {
    // Backstop for a disconnected consumer (early `return()`): the finally still
    // settles exactly once (idempotent via `settled` + the DB transition guard).
    await finalize();
  }
}

/**
 * Best-effort `usage_log` mirror for a settled chat stream (§C.4). No-op unless
 * `req.usageLogModel` is set. Token counts come from the snake_case
 * {@link UsageVector} captured from the IR `usage` event (missing → 0). Any error
 * is swallowed: the ledger settle is the source of truth.
 */
async function mirrorChatUsageLog(
  deps: SettlingStreamDeps,
  usage: UsageVector | undefined,
  finalCost: MicroCredits,
  served?: {
    channelId: string;
    providerType: string;
    inputCostPer1m?: bigint | null | undefined;
    outputCostPer1m?: bigint | null | undefined;
  },
): Promise<void> {
  const model = deps.req.usageLogModel;
  if (model === undefined) return;
  try {
    await insertUsageLog(deps.db, {
      tenantId: deps.req.tenantId,
      subjectId: deps.req.subjectId ?? null,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cost: finalCost,
      status: 'succeeded',
      ...(deps.req.routeTag !== undefined ? { routeTag: deps.req.routeTag } : {}),
      ...(served !== undefined
        ? {
            channelId: served.channelId,
            providerType: served.providerType,
            // Track 5: the served channel's actual cost (µUSD) for this stream,
            // from its cost rates (null → 0) + observed usage (margin analytics).
            providerCost: priceProviderCost(
              usage ?? {},
              served.inputCostPer1m,
              served.outputCostPer1m,
            ),
          }
        : {}),
      ...(deps.req.usageLogApiKeyId !== undefined ? { apiKeyId: deps.req.usageLogApiKeyId } : {}),
    });
  } catch {
    // Best-effort observability: never fail a settled run on a usage-log error.
  }
}

/**
 * Settle the job once with the policy: when real usage was captured, charge the
 * true computed cost; when usage is **absent/empty** (client disconnect or an
 * error before the upstream's final usage frame), charge the held upper bound —
 * never 0, which would leak revenue (provider tokens consumed but unbilled). The
 * charge is always capped at `holdAmount` (we never settle above the hold) and
 * floored at 0.
 */
async function settleStream(
  deps: SettlingStreamDeps,
  usage: UsageVector | undefined,
): Promise<MicroCredits> {
  const entry = deps.req.pricebookEntry;
  const hasUsage = usage !== undefined && Object.keys(usage).length > 0;
  const { credits: computed, applied } = computeFinalCost(
    entry,
    usage ?? {},
    deps.inputs,
    deps.req.modifiers,
  );
  // No-usage path: charge the held upper bound rather than the empty-usage 0.
  const candidate = hasUsage ? computed : deps.holdAmount;
  // Cap at the hold (never settle above what we reserved); floor at 0.
  const finalCost = candidate < 0n ? 0n : candidate > deps.holdAmount ? deps.holdAmount : candidate;
  await settleJob(deps.db, {
    jobId: deps.jobId,
    accountId: deps.req.accountId,
    tenantId: deps.req.tenantId,
    subjectId: deps.req.subjectId ?? null,
    holdAmount: deps.holdAmount,
    finalCost,
    usage: usage ?? {},
    output: {},
    pricebookVersion: entry.version,
    modifiersApplied: serializeAppliedModifiers(applied),
    resourceId: deps.req.resource.id,
    ...(deps.req.callbackUrl !== undefined
      ? { outbox: { url: deps.req.callbackUrl, payload: { job_id: deps.jobId } } }
      : {}),
  });
  return finalCost;
}

/**
 * Fail the job (release the hold, no charge) once. Exported so
 * {@link ExecutionService.runChatStream} can release the hold on a total
 * pre-commit failure the SAME way the drain generator's `finalize` would.
 */
export async function failStream(deps: SettlingStreamDeps, error: UnifiedError): Promise<void> {
  await failJob(deps.db, {
    jobId: deps.jobId,
    accountId: deps.req.accountId,
    tenantId: deps.req.tenantId,
    subjectId: deps.req.subjectId ?? null,
    holdAmount: deps.holdAmount,
    to: 'failed',
    error,
    ...(deps.req.callbackUrl !== undefined
      ? { outbox: { url: deps.req.callbackUrl, payload: { job_id: deps.jobId, error } } }
      : {}),
  });
}

/**
 * Wrap the stream's `http` in a {@link TracingHttpClient} when tracing is on,
 * else return it unwrapped. Best-effort `insertRelayTrace` sink — a trace-write
 * failure never affects the relayed stream.
 */
function maybeTrace(deps: SettlingStreamDeps, trace: TraceContext): HttpClient {
  if (deps.traceUpstream !== true) return deps.http;
  return new TracingHttpClient(
    deps.http,
    async (row) => {
      await insertRelayTrace(deps.db, row);
    },
    trace,
    deps.traceMaxBytes ?? DEFAULT_TRACE_MAX_BYTES,
  );
}

/** Build the streaming adapter context, resolving the channel secret. */
async function buildContext(
  deps: SettlingStreamDeps,
  channel: RunChannel | undefined,
): Promise<AdapterContext> {
  const providerType = channel?.providerType ?? deps.req.resource.providerType;
  const ctx: AdapterContext = {
    providerType: deps.req.resource.providerType,
    // Layer the channel's fault-policy timeouts (TTFT / idle / total) OVER the
    // trace wrapper so the stream honors the time-to-first-token deadline.
    http: wrapHttpWithTimeouts(
      maybeTrace(deps, {
        tenantId: deps.req.tenantId,
        jobId: deps.jobId,
        providerType,
        ...(channel !== undefined ? { channelId: channel.id } : {}),
        ...(deps.req.routeTag !== undefined ? { routeTag: deps.req.routeTag } : {}),
      }),
      channel?.faultPolicy,
    ),
  };
  if (channel === undefined) {
    // No channel: the global egress proxy fallback still applies.
    if (deps.proxyUrlEnv !== undefined) ctx.proxyUrl = deps.proxyUrlEnv;
    return ctx;
  }
  if (channel.model !== undefined) ctx.model = channel.model;
  if (channel.endpoint !== undefined) ctx.endpoint = channel.endpoint;
  if (channel.credentialRef !== undefined) {
    const apiKey = await deps.resolveSecret(channel.credentialRef);
    if (apiKey !== undefined) ctx.apiKey = apiKey;
  }
  const proxyUrl = await resolveProxy(deps, channel);
  if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;
  if (channel.config !== undefined) ctx.config = channel.config;
  return ctx;
}

/** Resolve a channel's egress proxy URL: its proxyRef (via resolveSecret), else the global env fallback. */
async function resolveProxy(
  deps: SettlingStreamDeps,
  channel: RunChannel,
): Promise<string | undefined> {
  if (channel.proxyRef !== undefined) {
    const url = await deps.resolveSecret(channel.proxyRef);
    if (url !== undefined) return url;
  }
  return deps.proxyUrlEnv;
}

/** Coerce any thrown value into a sanitized unified error payload. */
function toUnified(err: unknown): UnifiedError {
  if (err instanceof EngineError) return err.unified;
  if (typeof err === 'object' && err !== null && 'unified' in err) {
    const carrier = err.unified;
    if (typeof carrier === 'object' && carrier !== null) {
      return carrier as UnifiedError;
    }
  }
  return { code: 'upstream_error', message: 'upstream error', retryable: false };
}
