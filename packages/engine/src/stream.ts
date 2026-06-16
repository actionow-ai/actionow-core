import type { AdapterRegistry } from '@actionow/adapters';
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
import { type DbOrTx, failJob, insertUsageLog, settleJob } from '@actionow/db';
import type { MicroCredits } from '@actionow/domain';

import { EngineError } from './errors.js';
import type { RunChannel, RunRequest } from './execution-service.js';
import { computeFinalCost, serializeAppliedModifiers } from './pricing.js';

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
 * IR chat variant of {@link createSettlingStream}: drives the adapter's
 * `streamChat` over the IR `ChatRequest` placed at `deps.inputs.__ir`, forwards
 * every IR {@link ChatStreamEvent} verbatim to the consumer (including the IR
 * `done`), and **settles exactly once** in `finally` via the SAME
 * `settleStream`/`failStream` helpers — on normal completion, on an IR `error`
 * event (→ fail/release + throw), AND on consumer early-`return()` (disconnect).
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
 * `StreamOutcome.jobId` `runChatStream` returns (known before streaming begins).
 */
export async function* createChatSettlingStream(
  deps: SettlingStreamDeps,
): AsyncGenerator<ChatStreamEvent> {
  const adapter = deps.adapters.get(deps.req.resource.providerType);
  if (adapter.streamChat === undefined) {
    throw new EngineError({
      code: 'internal_error',
      message: `adapter ${deps.req.resource.providerType} cannot streamChat`,
      retryable: false,
    });
  }
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

  /**
   * Settle (success) or fail (release) exactly once, then — on the success path
   * with a configured model — mirror the `usage_log` row (best-effort).
   */
  const finalize = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    if (failure !== undefined) {
      await failStream(deps, failure);
      return;
    }
    const finalCost = await settleStream(deps, latestUsage);
    await mirrorChatUsageLog(deps, latestUsage, finalCost);
  };

  try {
    const ctx = await buildContext(deps, deps.req.channels[0]);
    for await (const ev of adapter.streamChat(ir, ctx)) {
      if (ev.type === 'usage') {
        // camelCase IR → snake_case engine UsageVector at the boundary.
        latestUsage = { input_tokens: ev.usage.inputTokens, output_tokens: ev.usage.outputTokens };
      }
      if (ev.type === 'error') {
        // Route to fail/release + surface the thrown error (mirrors
        // createSettlingStream, which throws rather than yielding the error).
        failure = ev.error;
        throw new EngineError(failure);
      }
      // Forward every other IR event verbatim — including the IR `done`.
      yield ev;
    }
  } catch (err) {
    failure ??= toUnified(err);
    await finalize();
    throw err instanceof EngineError ? err : new EngineError(failure);
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
): Promise<void> {
  const model = deps.req.usageLogModel;
  if (model === undefined) return;
  try {
    await insertUsageLog(deps.db, {
      tenantId: deps.req.tenantId,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cost: finalCost,
      status: 'succeeded',
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

/** Fail the job (release the hold, no charge) once. */
async function failStream(deps: SettlingStreamDeps, error: UnifiedError): Promise<void> {
  await failJob(deps.db, {
    jobId: deps.jobId,
    accountId: deps.req.accountId,
    holdAmount: deps.holdAmount,
    to: 'failed',
    error,
    ...(deps.req.callbackUrl !== undefined
      ? { outbox: { url: deps.req.callbackUrl, payload: { job_id: deps.jobId, error } } }
      : {}),
  });
}

/** Build the streaming adapter context, resolving the channel secret. */
async function buildContext(
  deps: SettlingStreamDeps,
  channel: RunChannel | undefined,
): Promise<AdapterContext> {
  const ctx: AdapterContext = {
    providerType: deps.req.resource.providerType,
    http: deps.http,
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
