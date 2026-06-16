import type { AdapterRegistry } from '@actionow/adapters';
import type {
  AdapterContext,
  HttpClient,
  StreamEvent,
  SubmitInput,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { type DbOrTx, failJob, settleJob } from '@actionow/db';
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
    return settleStream(deps, latestUsage ?? {});
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

/** Compute the final cost from the observed usage and settle the job once. */
async function settleStream(deps: SettlingStreamDeps, usage: UsageVector): Promise<MicroCredits> {
  const entry = deps.req.pricebookEntry;
  const { credits: finalCost, applied } = computeFinalCost(
    entry,
    usage,
    deps.inputs,
    deps.req.modifiers,
  );
  await settleJob(deps.db, {
    jobId: deps.jobId,
    accountId: deps.req.accountId,
    tenantId: deps.req.tenantId,
    holdAmount: deps.holdAmount,
    finalCost,
    usage,
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
  if (channel === undefined) return ctx;
  if (channel.model !== undefined) ctx.model = channel.model;
  if (channel.endpoint !== undefined) ctx.endpoint = channel.endpoint;
  if (channel.credentialRef !== undefined) {
    const apiKey = await deps.resolveSecret(channel.credentialRef);
    if (apiKey !== undefined) ctx.apiKey = apiKey;
  }
  return ctx;
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
