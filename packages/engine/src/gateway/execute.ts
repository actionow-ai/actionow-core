// packages/engine/src/gateway/execute.ts
//
// model-supply-greenfield 批次4 slice2 — THE GATEWAY EXECUTION SERVICE: the
// one seam wiring GatewayRequest → planExecution (批次3) → SPI pipeline
// (批次2) → settle (§9.2), end to end. Red lines it owns:
//
//   §5   idempotency FIRST: same key + same body ⇒ replay the recorded task;
//        same key + DIFFERENT body ⇒ 409 conflict — checked BEFORE planning so
//        a replayed request never re-holds or re-dispatches. The claim is
//        PERSISTED for EVERY paradigm: task always writes its row; sync/stream
//        write one too WHEN the request carries an Idempotency-Key (the row is
//        the replay target and the hold reaper's rollback anchor); keyless
//        sync/stream stay lightweight (no row).
//   §7.8 gate order untouched: the hold was already placed by planExecution
//        (after the dual semaphore). This service dispatches upstream between
//        acquire and commit, and on ANY dispatch failure calls
//        `reservation.release()` — semaphore freed + hold rolled back. On
//        success the wallet settles inside the settle tx and only the SLOT is
//        released (hold 转 settle, never released twice).
//   §3   dispatch matrix (externalParadigm × fetch mode), COMPLETE:
//          sync   × direct           → runSync → settle → GatewayResponse
//          sync   × stream           → runStream, drain ALL frames, assemble a
//                                      sync response (§3 row `stream`: the
//                                      engine strategy is sync+stream — the
//                                      stream-fetch offering serves BOTH
//                                      external shapes)
//          sync   × submit_poll/cb   → submit + BOUNDED in-request block-poll
//                                      to the terminal state (§3 落可恢复模式=
//                                      阻塞排流), assembled as sync
//          stream × stream           → runStream, PRE-COMMIT: no 200 until the
//                                      first frame pulled; drain-settle once
//          stream × direct           → runSync, settle, wrap the single result
//                                      as a delta+done stream (优雅降级)
//          stream × submit_poll/cb   → NOT inline-servable (worker-synthesized
//                                      progress streams are a later slice) —
//                                      excluded at CANDIDATE ASSEMBLY by the
//                                      planner's §3 servability filter
//                                      (isServable); the branch here is a
//                                      DEFENSIVE assertion (internal_error)
//          task   × submit_poll/cb   → task row FIRST (§7.4 先落库再调上游) →
//                                      runTaskSubmit → 202 + Task (worker polls)
//          task   × direct           → AT-MOST-ONCE: task row + a long-blocking
//                                      runner; no upstream handle — crash ⇒
//                                      failed + NO charge, NEVER re-submitted
//          task   × stream           → same later-slice drain as stream×submit:
//                                      filtered at assembly, defensive here
//   §8   failover loop: a dispatch failure flagged `failover: true` releases
//        the reservation (hold rolled back), re-plans EXCLUDING every offering
//        already tried (planExecution re-runs assembly/filter/gate wholesale —
//        降级链每跳重过参数校验与映射 by construction) and dispatches the next
//        reservation, at most `maxFailoverHops` extra hops. `retryable`
//        (same-hop retry) stays the SPI/fault-policy layer's business; only
//        `failover` changes offering. §7.4 uncertain submits (timeout — the
//        upstream may hold an orphan) NEVER failover (宁可失败不盲目重提).
//   §7.3 hold TTL = min(model.max_run_time, offering budget) + buffer — the
//        15-minute legacy default is DEAD here.
//   §7.4 提交防重: the task row is durable BEFORE the upstream submit; an
//        uncertain (timeout) submit outcome fails the task rather than blind
//        re-submission (no handle to query by — 宁可失败).
import type {
  FetchMode,
  GatewayError,
  GatewayRequest,
  GatewayResponse,
  GatewayUsage,
  GatewayWarning,
  HttpClient,
  ServedBy,
  StreamFrame,
} from '@actionow/contracts';
import type { DbOrTx, SupplyModelRow, TaskRow } from '@actionow/db';
import {
  appendTaskEvent,
  claimTaskIdempotency,
  createTask,
  getSupplyProviderById,
  getTaskByUpstreamTaskId,
  renewTaskLease,
  resolveSupplyCredentialSecret,
  transitionTask,
} from '@actionow/db';
import type { Dialect, PipelineDeps, StreamRunHandle, SyncRunInput } from '@actionow/spi';
import {
  type DialectRegistry,
  runStream,
  runSync,
  runTaskQuery,
  runTaskSubmit,
} from '@actionow/spi';

import type {
  DeprecationNotice,
  PlanDeps,
  PlanExecutionInput,
  PlanSuccess,
  Reservation,
} from '../planner/index.js';
import { planExecution } from '../planner/index.js';
import { resolveDialectForOffering } from './dialect-resolve.js';
import type {
  GatewaySettleDeps,
  GatewaySettleRepo,
  PersistHook,
  SettleGatewayResultInput,
} from './settle-task.js';
import { failGatewayResult, settleGatewayResult, snapshotRef } from './settle-task.js';
import type { TaskWebhookEmitter } from './task-webhook.js';
import { emitTaskWebhookBestEffort } from './task-webhook.js';

// --- defaults (§7.3 / §8 / §3) ---------------------------------------------------

/** §7.3 hold-TTL buffer on top of the effective max run (dynamic-config wiring is later). */
export const DEFAULT_HOLD_BUFFER_SECONDS = 120;
/** Fallback effective max-run when NEITHER the model nor the offering declares one. */
export const DEFAULT_MAX_RUN_SECONDS = 3_600;
/** Initial lease horizon for recoverable-fetch tasks (slice4's worker renews, §7.2). */
export const DEFAULT_LEASE_SECONDS = 60;
/** §8 failover ceiling: at most this many EXTRA offerings are tried after the first. */
export const DEFAULT_MAX_FAILOVER_HOPS = 3;
/** §3 sync-over-submit block-poll cadence (adaptive backoff/jitter is the slice4 worker's). */
export const DEFAULT_SYNC_POLL_INTERVAL_MS = 1_000;

// --- deps & inputs ---------------------------------------------------------------

/** The extra db reads the gateway performs beyond the planner's (injectable). */
export interface GatewayQueries {
  getSupplyProviderById: typeof getSupplyProviderById;
  resolveSupplyCredentialSecret: typeof resolveSupplyCredentialSecret;
}

/** The slice1 task-repo surface the gateway drives (injectable). */
export interface GatewayTaskRepo {
  claimTaskIdempotency: typeof claimTaskIdempotency;
  createTask: typeof createTask;
  appendTaskEvent: typeof appendTaskEvent;
  transitionTask: typeof transitionTask;
  getTaskByUpstreamTaskId: typeof getTaskByUpstreamTaskId;
  /** §7.2 in-request 续租 — the block-poll keeps its lease ahead of the sweep. */
  renewTaskLease: typeof renewTaskLease;
}

/**
 * {@link executeGateway}'s dependency bag: the FULL planner deps (planExecution
 * is invoked with this same object) plus the SPI wiring and the task/settle
 * surfaces. Everything beyond the planner primitives has production defaults.
 */
export interface ExecuteGatewayDeps extends PlanDeps {
  /** The versioned SPI dialect registry (§6 热更新一致性). */
  dialectRegistry: DialectRegistry;
  /** The HttpClient the SPI pipeline transports over (§6-④). */
  spiHttp: HttpClient;
  /** Injectable planner (tests); production omits → the real planExecution. */
  planner?: typeof planExecution | undefined;
  /** This node's identity for task leases (§7.2); default 'gateway'. */
  ownerNode?: string | undefined;
  leaseSeconds?: number | undefined;
  holdBufferSeconds?: number | undefined;
  defaultMaxRunSeconds?: number | undefined;
  /** §8 failover ceiling override; default {@link DEFAULT_MAX_FAILOVER_HOPS}. */
  maxFailoverHops?: number | undefined;
  /** §3 sync-over-submit block-poll interval; default {@link DEFAULT_SYNC_POLL_INTERVAL_MS}. */
  syncPollIntervalMs?: number | undefined;
  /** Resolve a channel's proxy_ref to an egress proxy URL; absent → direct egress. */
  resolveProxyUrl?: ((proxyRef: string) => Promise<string | undefined>) | undefined;
  /** §7.5 artifact persistence hook (slice5 provides the real one). */
  persist?: PersistHook | undefined;
  /** §7.6 downstream-webhook emitter override (tests); absent → production emitter. */
  emitTaskWebhook?: TaskWebhookEmitter | undefined;
  gatewayQueries?: Partial<GatewayQueries> | undefined;
  taskRepo?: Partial<GatewayTaskRepo> | undefined;
  settleRepo?: Partial<GatewaySettleRepo> | undefined;
}

/** Everything planExecution needs beyond the request itself (accountId is auth-derived). */
export type ExecuteGatewayOptions = Omit<PlanExecutionInput, 'request'>;

// --- result ------------------------------------------------------------------------

export interface ExecuteResultBase {
  /** §10 下线预告 marker — the caller attaches the deprecation header. */
  deprecation?: DeprecationNotice | undefined;
  /** §4 rule 4 lenient-mode drop echoes (and any later additions). */
  warnings: GatewayWarning[];
}

export type ExecuteResult =
  | ({ kind: 'sync'; response: GatewayResponse } & ExecuteResultBase)
  | ({
      kind: 'stream';
      /** The pre-commit first frame, already pulled (§3) — NEVER an error frame. */
      firstFrame: StreamFrame;
      /** The settling stream: replays firstFrame, then the rest; settles EXACTLY once on drain/disconnect. */
      frames: AsyncIterable<StreamFrame>;
      servedBy: ServedBy;
    } & ExecuteResultBase)
  | ({
      kind: 'task';
      task: TaskRow;
      status: 202;
      servedBy: ServedBy;
      /**
       * Present ONLY for fetch=direct (§3 at-most-once): the long-blocking
       * execution the worker (or the API layer, fire-and-forget) drives. It
       * settles/fails the task itself and resolves to the terminal row.
       */
      run?: (() => Promise<TaskRow | undefined>) | undefined;
    } & ExecuteResultBase)
  | ({ kind: 'replay'; task: TaskRow } & ExecuteResultBase)
  | ({ kind: 'error'; error: GatewayError } & ExecuteResultBase);

// --- small helpers -------------------------------------------------------------------

function internalError(message: string): GatewayError {
  return { code: 'internal_error', message, retryable: false, failover: false };
}

/** §5 same-key-different-body verdict (409 at the wire). */
function conflictError(key: string): GatewayError {
  return {
    code: 'conflict',
    message: `Idempotency-Key '${key}' was already used with a different request body`,
    retryable: false,
    failover: false,
    details: { idempotencyKey: key },
  };
}

/** min over the DEFINED members; undefined when neither is set. */
function minDefined(
  a: number | null | undefined,
  b: number | null | undefined,
): number | undefined {
  if (a != null && b != null) return Math.min(a, b);
  return a ?? b ?? undefined;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMPTY_USAGE: GatewayUsage = { metrics: {}, billingDims: {}, estimated: false };

// --- the execution service -------------------------------------------------------------

/**
 * Execute one gateway request end to end. See the module header for the red
 * lines; the flow is: §5 idempotency → the §8 failover loop around
 * [planExecution (§7.8 reservation with the hold ALREADY placed) → dialect +
 * credential resolution → durable claim row when required → the §3 dispatch
 * matrix → settle (§9.2) or `reservation.release()` (§7.8 failure rollback)].
 */
export async function executeGateway(
  deps: ExecuteGatewayDeps,
  request: GatewayRequest,
  opts: ExecuteGatewayOptions,
): Promise<ExecuteResult> {
  const tasks: GatewayTaskRepo = {
    claimTaskIdempotency: deps.taskRepo?.claimTaskIdempotency ?? claimTaskIdempotency,
    createTask: deps.taskRepo?.createTask ?? createTask,
    appendTaskEvent: deps.taskRepo?.appendTaskEvent ?? appendTaskEvent,
    transitionTask: deps.taskRepo?.transitionTask ?? transitionTask,
    getTaskByUpstreamTaskId: deps.taskRepo?.getTaskByUpstreamTaskId ?? getTaskByUpstreamTaskId,
    renewTaskLease: deps.taskRepo?.renewTaskLease ?? renewTaskLease,
  };
  const queries: GatewayQueries = {
    getSupplyProviderById: deps.gatewayQueries?.getSupplyProviderById ?? getSupplyProviderById,
    resolveSupplyCredentialSecret:
      deps.gatewayQueries?.resolveSupplyCredentialSecret ?? resolveSupplyCredentialSecret,
  };
  const settleDeps: GatewaySettleDeps = {
    db: deps.db,
    repo: {
      ...(deps.taskRepo?.transitionTask !== undefined
        ? { transitionTask: deps.taskRepo.transitionTask }
        : {}),
      ...deps.settleRepo,
    },
    ...(deps.emitTaskWebhook !== undefined ? { emitTaskWebhook: deps.emitTaskWebhook } : {}),
  };

  // ── 1. §5 idempotency — BEFORE any planning/holding, for EVERY paradigm
  //       (the claim row persists for sync/stream too — see the durable-row
  //       step below). Same key + same body replays the recorded task; same
  //       key + different body is a HARD 409 (never a silent replay). ───────
  if (request.idempotency !== undefined) {
    const claim = await tasks.claimTaskIdempotency(deps.db, {
      tenantId: request.tenantId,
      apiKeyId: request.apiKeyId,
      idempotencyKey: request.idempotency.key,
      fingerprint: request.idempotency.bodyFingerprint,
    });
    if (!claim.claimed) {
      if (!claim.fingerprintMatch) {
        return { kind: 'error', error: conflictError(request.idempotency.key), warnings: [] };
      }
      return { kind: 'replay', task: claim.existing, warnings: [] };
    }
  }

  // ── 2. the §8 failover loop around plan → dispatch. Each iteration re-runs
  //       the FULL planner (visibility → paradigm → candidates → sort → §7.8
  //       gates) excluding every offering already tried, so 每跳重过参数校验
  //       与映射 holds by construction. Plan failures pass through VERBATIM
  //       on the first hop; mid-failover exhaustion answers the LAST dispatch
  //       error (the caller sees WHY the supply failed, not "no supply"). ───
  const planner = deps.planner ?? planExecution;
  const maxHops = deps.maxFailoverHops ?? DEFAULT_MAX_FAILOVER_HOPS;
  const excluded: string[] = [...(opts.excludeOfferingIds ?? [])];
  /** Offerings this request dispatched to and failed over from (hop counter). */
  let hops = 0;
  /** The idempotency/task row carried ACROSS hops (re-bound per reservation). */
  let carriedTask: TaskRow | undefined;
  let lastFailure: { error: GatewayError; base: ExecuteResultBase } | undefined;

  for (;;) {
    const plan = await planner(deps, {
      request,
      ...opts,
      ...(excluded.length > 0 ? { excludeOfferingIds: excluded } : {}),
    });
    if (!plan.ok) {
      if (lastFailure !== undefined) {
        // Candidates exhausted mid-failover: the carried row (its hold was
        // already rolled back by the failing hop's release) is failed WITHOUT
        // any wallet movement, and the LAST dispatch error answers.
        if (carriedTask !== undefined) {
          await tasks.transitionTask(deps.db, carriedTask.id, ['pending', 'running'], 'failed', {
            error: lastFailure.error,
            finishedAt: deps.now(),
            eventPayload: { failoverExhausted: true, error: lastFailure.error },
          });
        }
        return { kind: 'error', error: lastFailure.error, ...lastFailure.base };
      }
      return {
        kind: 'error',
        error: plan.error,
        deprecation: plan.deprecation,
        warnings: plan.warnings,
      };
    }

    const outcome = await dispatchPlan(deps, settleDeps, tasks, queries, {
      request,
      opts,
      plan,
      existingTask: carriedTask,
    });
    if (outcome.kind === 'final') return outcome.result;

    // outcome.kind === 'failover' — the dispatch failed with failover:true and
    // NOTHING has been released or terminally failed yet.
    const offeringId = plan.reservation.candidate.offering.id;
    const base: ExecuteResultBase = { deprecation: plan.deprecation, warnings: plan.warnings };
    if (hops >= maxHops) {
      await failGatewayResult(settleDeps, {
        error: outcome.error,
        task: outcome.task,
        reservation: plan.reservation,
      });
      return { kind: 'error', error: outcome.error, ...base };
    }
    // Row-first, release-second: zero the row's hold column BEFORE rolling the
    // wallet hold back, so a crash between the two leaves the reaper NOTHING
    // to double-release (the §7.8 rollback below is an unconditional wallet
    // credit; a crash the other way around leaks a held amount, which is the
    // conservative failure). The next hop re-stamps the row with ITS hold.
    // The abandoned hop's upstream traces (handle/progress) are cleared HERE
    // already — not just at the re-bind — so its late callback cannot hit the
    // row during the re-plan window either.
    if (outcome.task !== undefined) {
      const rerouting = await tasks.transitionTask(
        deps.db,
        outcome.task.id,
        ['pending', 'running'],
        'running',
        {
          holdAmount: 0n,
          upstreamTaskId: null,
          progress: null,
          internalSubstate: 'failover_reroute',
          eventPayload: { failover: true, offeringId, error: outcome.error },
        },
      );
      carriedTask = rerouting ?? outcome.task;
    }
    await plan.reservation.release();
    hops += 1;
    excluded.push(offeringId);
    lastFailure = { error: outcome.error, base };
  }
}

// --- one planned dispatch (a single §8 hop) ----------------------------------------------

interface DispatchInput {
  request: GatewayRequest;
  opts: ExecuteGatewayOptions;
  plan: PlanSuccess;
  /** The claim/task row carried from a previous hop (§8 failover re-bind). */
  existingTask?: TaskRow | undefined;
}

type DispatchOutcome =
  | { kind: 'final'; result: ExecuteResult }
  | {
      kind: 'failover';
      error: GatewayError;
      /** The still-RUNNING row (when one exists) — the outer loop re-binds it. */
      task?: TaskRow | undefined;
    };

/**
 * One planned dispatch, INFRA-EXCEPTION-SEALED (§7.8): planExecution already
 * placed the hold, so a throw anywhere in the dispatch (db deadlock /
 * connection loss / task-event seq exhaustion / a createTask conflict row
 * vanishing / a settle-tx failure) must NEVER escape with the reservation
 * still held — a keyless sync/stream request has no row for the hold reaper
 * and would leak its hold PERMANENTLY. The catch runs failGatewayResult
 * (reservation released = hold rolled back + both semaphore dimensions freed;
 * when the row was already terminalized by another writer the release is
 * skipped — no double-free) and answers internal_error{retryable: true}.
 */
async function dispatchPlan(
  deps: ExecuteGatewayDeps,
  settleDeps: GatewaySettleDeps,
  tasks: GatewayTaskRepo,
  queries: GatewayQueries,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  /** The freshest durable row this dispatch touched — the catch's fail target. */
  const tracked: { row: TaskRow | undefined } = { row: input.existingTask };
  try {
    return await dispatchPlanInner(deps, settleDeps, tasks, queries, input, tracked);
  } catch (err) {
    const error: GatewayError = {
      code: 'internal_error',
      message: `gateway dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
      failover: false,
    };
    try {
      await failGatewayResult(settleDeps, {
        error,
        task: tracked.row,
        reservation: input.plan.reservation,
      });
    } catch {
      // The rollback itself failed (the same infra is down). Row-backed holds
      // are the slice4 reaper's to recover from the task columns; never mask
      // the dispatch verdict with a second throw.
    }
    return {
      kind: 'final',
      result: {
        kind: 'error',
        error,
        deprecation: input.plan.deprecation,
        warnings: input.plan.warnings,
      },
    };
  }
}

async function dispatchPlanInner(
  deps: ExecuteGatewayDeps,
  settleDeps: GatewaySettleDeps,
  tasks: GatewayTaskRepo,
  queries: GatewayQueries,
  input: DispatchInput,
  /** Out-param: keeps {@link dispatchPlan}'s catch aware of the durable row. */
  tracked: { row: TaskRow | undefined },
): Promise<DispatchOutcome> {
  const { request, opts, plan } = input;
  const { reservation, paradigmPlan, fetchPlan, model } = plan;
  const offering = reservation.candidate.offering;
  const base: ExecuteResultBase = { deprecation: plan.deprecation, warnings: plan.warnings };

  const final = (result: ExecuteResult): DispatchOutcome => ({ kind: 'final', result });

  /** Terminal failure: task (when present) → failed + reservation.release() (§7.8 rollback). */
  const abort = async (error: GatewayError, task?: TaskRow): Promise<DispatchOutcome> => {
    await failGatewayResult(settleDeps, { error, task, reservation });
    return final({ kind: 'error', error, ...base });
  };

  /**
   * A DISPATCH failure verdict: failover-eligible errors bubble to the outer
   * §8 loop (which rolls back and re-plans); everything else — including §7.4
   * UNCERTAIN submits, which must never re-submit anywhere — fails terminally.
   */
  const dispatchFailed = (
    error: GatewayError,
    task: TaskRow | undefined,
    uncertain: boolean,
  ): Promise<DispatchOutcome> | DispatchOutcome => {
    if (error.failover && !uncertain) return { kind: 'failover', error, task };
    return abort(error, task);
  };

  // ── dialect + credential resolution (§2.2/§2.3/§6) — config defects, final. ─
  const provider = await queries.getSupplyProviderById(deps.db, offering.channel.providerId);
  const resolved = resolveDialectForOffering(
    { registry: deps.dialectRegistry },
    {
      channel: offering.channel,
      provider:
        provider !== undefined
          ? {
              slug: provider.slug,
              defaultDialect: provider.defaultDialect,
              callbackVerification: provider.callbackVerification,
              region: provider.region,
            }
          : undefined,
      nowMs: deps.nowMs?.() ?? Date.now(),
    },
  );
  if (!resolved.ok) return abort(resolved.error, input.existingTask);

  const secret = await queries.resolveSupplyCredentialSecret(deps.db, reservation.credential.id);
  if (secret === undefined) {
    return abort(
      internalError(
        `credential ${reservation.credential.id} secret is unresolvable (vault miss or shape drift)`,
      ),
      input.existingTask,
    );
  }

  // ── SPI pipeline wiring (§6-④): effective budget = min(model.max_run,
  //    offering budget); channel proxy resolved when a resolver is wired. ────
  const effectiveMaxRun = minDefined(model.maxRunTimeSeconds, offering.timeoutBudgetSeconds);
  const proxyUrl =
    offering.channel.proxyRef !== null && deps.resolveProxyUrl !== undefined
      ? await deps.resolveProxyUrl(offering.channel.proxyRef)
      : undefined;
  const pipeline: PipelineDeps = {
    http: deps.spiHttp,
    budget: effectiveMaxRun !== undefined ? { totalTimeoutMs: effectiveMaxRun * 1000 } : {},
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
  };
  const syncInput: SyncRunInput = {
    operation: request.operation,
    upstreamModelName: offering.upstreamModelName,
    params: plan.effective,
    secret,
    ctx: resolved.ctx,
  };
  const servedBy: ServedBy = {
    offeringId: offering.id,
    channelId: offering.channel.id,
    ...(provider !== undefined ? { provider: provider.slug } : {}),
    upstreamModelName: offering.upstreamModelName,
  };
  const settleBase = buildSettleBase(deps, request, opts, plan);

  // ── durable claim row (§5/§7.4): the task paradigm ALWAYS persists; sync/
  //    stream persist IFF the request carries an idempotency key (幂等对全
  //    范式持久化 — the row is the replay target, the settle-dedup anchor and
  //    the reaper's rollback target). Keyless sync/stream stay row-less. ────
  const needsRow = paradigmPlan.externalParadigm === 'task' || request.idempotency !== undefined;
  let taskRow: TaskRow | undefined = input.existingTask;
  if (needsRow) {
    const ensured = await ensureDurableTask(deps, tasks, settleDeps, {
      request,
      opts,
      plan,
      effectiveMaxRun,
      existing: input.existingTask,
      base,
      tracked,
    });
    if (!ensured.ok) return final(ensured.result);
    taskRow = ensured.task;
    tracked.row = taskRow;
  }

  // ── the §3 dispatch matrix. ─────────────────────────────────────────────────
  switch (paradigmPlan.externalParadigm) {
    case 'sync': {
      const fetched = await runSyncShaped(deps, tasks, {
        fetchMode: fetchPlan.mode,
        dialect: resolved.dialect,
        syncInput,
        pipeline,
        effectiveMaxRun,
        task: taskRow,
      });
      if (!fetched.ok) {
        return dispatchFailed(fetched.error, taskRow, fetched.uncertain ?? false);
      }
      const settled = await settleGatewayResult(settleDeps, {
        ...settleBase,
        usage: fetched.usage,
        output: fetched.output,
        task: taskRow,
        reservation,
      });
      if (!settled.ok) return final({ kind: 'error', error: settled.error, ...base });
      // §7.5/§9.4: persist-degrade / policy warnings join the response echo.
      const syncWarnings = [...plan.warnings, ...(settled.warnings ?? [])];
      const response: GatewayResponse = {
        operation: request.operation,
        model: request.model,
        // The persist hook may have REWRITTEN the delivered output (§7.5 转存
        // URL 替换) — deliver what actually settled, never the pre-persist raw.
        output: settled.output ?? fetched.output,
        usage: {
          metrics: fetched.usage.metrics,
          billingDims: plan.billingDims,
          estimated: settled.estimated,
        },
        servedBy,
        warnings: syncWarnings,
      };
      return final({ kind: 'sync', response, ...base, warnings: syncWarnings });
    }

    case 'stream': {
      if (fetchPlan.mode === 'stream') {
        const handle = runStream(resolved.dialect, syncInput, pipeline);
        const first = await handle.firstFrame;
        if (first.kind === 'error') {
          // §3 pre-commit: the open failed → a REAL HTTP error, no 200, no
          // stream — and nothing was delivered, so §8 failover may reroute.
          return dispatchFailed(first.error, taskRow, false);
        }
        const frames = settlingStream(settleDeps, {
          frames: handle.frames,
          settleInput: { ...settleBase, reservation, task: taskRow },
        });
        return final({ kind: 'stream', firstFrame: first, frames, servedBy, ...base });
      }
      if (fetchPlan.mode === 'direct') {
        // §3 优雅降级: one buffered upstream call wrapped as a single-delta
        // stream. The work COMPLETES before any frame is delivered, so the
        // settle is EAGER (a disconnecting consumer must not un-charge
        // finished work) and the frames are pure delivery.
        const run = await runSync(resolved.dialect, syncInput, pipeline);
        if (!run.ok) return dispatchFailed(run.error, taskRow, false);
        const settled = await settleGatewayResult(settleDeps, {
          ...settleBase,
          usage: run.usage,
          output: run.output,
          task: taskRow,
          reservation,
        });
        if (!settled.ok) return final({ kind: 'error', error: settled.error, ...base });
        const doneUsage: GatewayUsage = {
          metrics: run.usage.metrics,
          billingDims: plan.billingDims,
          estimated: settled.estimated,
        };
        // §7.5: deliver the SETTLED (possibly persist-rewritten) output.
        const firstFrame: StreamFrame = { kind: 'delta', payload: settled.output ?? run.output };
        return final({
          kind: 'stream',
          firstFrame,
          frames: replayFrames(firstFrame, { kind: 'done', usage: doneUsage, servedBy }),
          servedBy,
          ...base,
          warnings: [...plan.warnings, ...(settled.warnings ?? [])],
        });
      }
      // stream × submit_poll/submit_callback: NOT inline-servable (worker-
      // synthesized progress streams are a later slice). The planner's §3
      // servability filter (isServable, candidate assembly) excludes these
      // pairings BEFORE any hold — this branch is a DEFENSIVE assertion for
      // planner/registry drift only, never the normal path: fail terminally
      // (abort releases the reservation) instead of spinning the §8 loop over
      // a systematically unservable pairing.
      return abort(
        internalError(
          `stream paradigm reached dispatch over fetch mode '${fetchPlan.mode}' — the §3 servability filter must exclude this candidate before planning`,
        ),
        taskRow,
      );
    }

    case 'task': {
      if (taskRow === undefined) {
        // Unreachable: needsRow covers the task paradigm — defensive only.
        return abort(internalError('task paradigm reached dispatch without a durable row'));
      }
      return executeTaskParadigm(deps, settleDeps, {
        plan,
        tasks,
        dialect: resolved.dialect,
        syncInput,
        pipeline,
        servedBy,
        base,
        settleBase,
        taskRow,
        final,
        abort,
        dispatchFailed,
      });
    }
  }
}

// --- durable claim/task row (§5/§7.4 step 1 + §8 re-bind) ---------------------------------

interface EnsureTaskInput {
  request: GatewayRequest;
  opts: ExecuteGatewayOptions;
  plan: PlanSuccess;
  effectiveMaxRun: number | undefined;
  /** A previous hop's row (§8 failover) — re-bound instead of re-created. */
  existing: TaskRow | undefined;
  base: ExecuteResultBase;
  /**
   * {@link dispatchPlan}'s catch target: updated the INSTANT a row of OURS
   * exists, so an infra throw between createTask and any later transition
   * still lets the catch fail the row (a dangling pending row with stamped
   * hold columns would otherwise become a reaper double-release target once
   * the catch rolls the reservation back).
   */
  tracked: { row: TaskRow | undefined };
}

type EnsureTaskResult = { ok: true; task: TaskRow } | { ok: false; result: ExecuteResult };

/**
 * Make the durable row for this hop: create it (§7.4 先落库再调上游 step 1 —
 * hold/billing columns land AT INSERT so a crash before any transition still
 * leaves the hold reaper a complete rollback target; createTask's ON CONFLICT
 * is the §5 race backstop) or, on a §8 failover hop, RE-BIND the carried row
 * to the new reservation (offering/fetch/hold/lease columns re-stamped — §7.3
 * 每跳重算 hold TTL included). Recoverable fetch modes get an owner/lease so
 * the slice4 worker can take over after a crash; direct/stream never lease.
 */
async function ensureDurableTask(
  deps: ExecuteGatewayDeps,
  tasks: GatewayTaskRepo,
  settleDeps: GatewaySettleDeps,
  input: EnsureTaskInput,
): Promise<EnsureTaskResult> {
  const { request, plan } = input;
  const { reservation, fetchPlan, model } = plan;
  const offering = reservation.candidate.offering;
  const now = deps.now();

  // §7.3 hold TTL = effective max run (min(model, offering)) + buffer — NEVER
  // the legacy 15-minute default.
  const maxRunSeconds =
    input.effectiveMaxRun ?? deps.defaultMaxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS;
  const bufferSeconds = deps.holdBufferSeconds ?? DEFAULT_HOLD_BUFFER_SECONDS;
  const holdExpiresAt = new Date(now.getTime() + (maxRunSeconds + bufferSeconds) * 1000);
  const wallet = reservation.holdTxn.wallet;
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  if (input.existing !== undefined) {
    // §8 failover re-bind: the SAME claim row follows the new reservation.
    // NOTE: row.inputs keeps hop-0's EffectiveParams snapshot — canonical
    // billingDims are candidate-invariant (§4 rule 2), so the charge side is
    // unaffected; the new hop's upstream bag is recorded on the event for
    // cost-side audit (slice4 handoff). The PREVIOUS hop's upstream traces are
    // cleared explicitly: a stale upstreamTaskId would let hop A's LATE
    // callback (getTaskByUpstreamTaskId) find and terminalize this row while
    // hop B is in flight — B's real settle then degrades to a no-op (漏收).
    const rebound = await tasks.transitionTask(
      deps.db,
      input.existing.id,
      ['pending', 'running'],
      'running',
      {
        internalSubstate: 'dispatching',
        upstreamTaskId: null,
        progress: null,
        offeringId: offering.id,
        fetchMode: fetchPlan.mode,
        maxRunTimeSeconds: maxRunSeconds,
        holdExpiresAt,
        holdAmount: reservation.holdAmount,
        subAccountId: wallet.kind === 'subject' ? wallet.subAccountId : null,
        saleCardRef: snapshotRef(reservation.saleCardRef),
        costCardRef: snapshotRef(reservation.costCardRef),
        ownerNode: fetchPlan.recoverable ? (deps.ownerNode ?? 'gateway') : null,
        leaseUntil: fetchPlan.recoverable ? new Date(now.getTime() + leaseSeconds * 1000) : null,
        eventPayload: {
          failoverRebind: true,
          offeringId: offering.id,
          fetchMode: fetchPlan.mode,
          effective: plan.effective,
          billingDims: plan.billingDims,
        },
      },
    );
    if (rebound === undefined) {
      const error = internalError(
        `task ${input.existing.id} could not be re-bound for failover (vanished or already terminal)`,
      );
      await failGatewayResult(settleDeps, { error, reservation });
      return { ok: false, result: { kind: 'error', error, ...input.base } };
    }
    return { ok: true, task: rebound };
  }

  const created = await tasks.createTask(deps.db, {
    tenantId: request.tenantId,
    apiKeyId: request.apiKeyId,
    subjectId: request.subjectId ?? null,
    operation: request.operation,
    modelId: model.id,
    offeringId: offering.id,
    fetchMode: fetchPlan.mode,
    maxRunTimeSeconds: maxRunSeconds,
    holdExpiresAt,
    holdAmount: reservation.holdAmount,
    accountId: input.opts.accountId,
    subAccountId: wallet.kind === 'subject' ? wallet.subAccountId : null,
    saleCardRef: snapshotRef(reservation.saleCardRef),
    costCardRef: snapshotRef(reservation.costCardRef),
    artifactMode: request.options.artifactMode ?? modelArtifactMode(model),
    requestFingerprint: request.idempotency?.bodyFingerprint ?? null,
    idempotencyKey: request.idempotency?.key ?? null,
    callbackUrl: request.options.callbackUrl ?? null,
    // The IR snapshot PLUS the planner's settle-time inputs (§4.1: EffectiveParams
    // recorded in full). The slice4 worker settles from THESE — billingDims /
    // effective / the resolved modifier stack are request-scoped and otherwise
    // unrecoverable after the request ends.
    inputs: {
      model: request.model,
      params: request.params,
      options: request.options,
      effective: plan.effective,
      billingDims: plan.billingDims,
      modifiers: input.opts.modifiers ?? [],
    },
  });
  if (created.created) {
    // Ours from this instant: an infra throw below (event append / running
    // transition) must let dispatchPlan's catch fail THIS row, not orphan it
    // as pending with live hold columns.
    input.tracked.row = created.task;
  } else {
    // Lost the §5 claim race between the pre-check and the insert: the winner's
    // row answers (and is NOT ours to fail). This request's reservation must
    // not leak.
    await reservation.release();
    const match =
      created.task.requestFingerprint !== null &&
      created.task.requestFingerprint === request.idempotency?.bodyFingerprint;
    if (!match) {
      return {
        ok: false,
        result: {
          kind: 'error',
          error: conflictError(request.idempotency?.key ?? ''),
          ...input.base,
        },
      };
    }
    return { ok: false, result: { kind: 'replay', task: created.task, ...input.base } };
  }
  await tasks.appendTaskEvent(deps.db, {
    taskId: created.task.id,
    fromStatus: null,
    toStatus: 'pending',
    payload: {
      operation: request.operation,
      model: request.model,
      autoUpgraded: plan.paradigmPlan.autoUpgraded,
    },
  });

  // pending → running (owner/lease only for RECOVERABLE modes — direct is
  // at-most-once and never leased, §7.2/§3).
  const running = await tasks.transitionTask(deps.db, created.task.id, ['pending'], 'running', {
    internalSubstate: 'dispatching',
    startedAt: now,
    ...(fetchPlan.recoverable
      ? {
          ownerNode: deps.ownerNode ?? 'gateway',
          leaseUntil: new Date(now.getTime() + leaseSeconds * 1000),
        }
      : {}),
    eventPayload: { fetchMode: fetchPlan.mode, offeringId: offering.id },
  });
  if (running === undefined) {
    const error = internalError(
      `task ${created.task.id} vanished between create and dispatch transition`,
    );
    await failGatewayResult(settleDeps, { error, task: created.task, reservation });
    return { ok: false, result: { kind: 'error', error, ...input.base } };
  }
  // §7.6 'task.running' envelope (best-effort, deterministic evt_id — a §8
  // failover re-bind never double-delivers). Only rows with a callback_url
  // enqueue anything.
  await emitTaskWebhookBestEffort(
    { db: deps.db, emit: deps.emitTaskWebhook },
    running,
    'task.running',
  );
  return { ok: true, task: running };
}

// --- sync-shaped fetch dispatch (§3 matrix, sync row) ---------------------------------------

/** One fetch-dispatch verdict on the sync-shaped paths (direct / drained stream / block-poll). */
type SyncFetchOutcome =
  | { ok: true; output: unknown; usage: GatewayUsage }
  | {
      ok: false;
      error: GatewayError;
      /** §7.4: an UNCERTAIN submit (timeout — the upstream may hold an orphan) must never failover (宁可失败). */
      uncertain?: boolean;
    };

interface RunSyncShapedInput {
  fetchMode: FetchMode;
  dialect: Dialect;
  syncInput: SyncRunInput;
  pipeline: PipelineDeps;
  effectiveMaxRun: number | undefined;
  /** The durable row (idempotent path) — substates/handles are recorded on it. */
  task: TaskRow | undefined;
}

/** Dispatch a SYNC-paradigm request over whichever fetch mode the offering declares (§3). */
async function runSyncShaped(
  deps: ExecuteGatewayDeps,
  tasks: GatewayTaskRepo,
  input: RunSyncShapedInput,
): Promise<SyncFetchOutcome> {
  switch (input.fetchMode) {
    case 'direct': {
      const run = await runSync(input.dialect, input.syncInput, input.pipeline);
      if (!run.ok) return { ok: false, error: run.error };
      return { ok: true, output: run.output, usage: run.usage };
    }
    case 'stream':
      // §3 matrix row `stream` (引擎策略 = sync+stream): drain + assemble.
      return drainStreamToSync(runStream(input.dialect, input.syncInput, input.pipeline));
    case 'submit_poll':
    case 'submit_callback':
      return submitAndBlockPoll({
        dialect: input.dialect,
        syncInput: input.syncInput,
        pipeline: input.pipeline,
        budgetSeconds:
          input.effectiveMaxRun ?? deps.defaultMaxRunSeconds ?? DEFAULT_MAX_RUN_SECONDS,
        intervalMs: deps.syncPollIntervalMs ?? DEFAULT_SYNC_POLL_INTERVAL_MS,
        sleep: deps.sleep ?? sleepMs,
        nowMs: deps.nowMs ?? Date.now,
        task: input.task,
        tasks,
        db: deps.db,
        ownerNode: deps.ownerNode ?? 'gateway',
        leaseSeconds: deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      });
  }
}

// --- §3 sync-over-stream drain + minimal assembly contract ----------------------------------

/**
 * §3 sync-over-stream 最小组装契约: accumulate drained StreamFrame deltas into
 * ONE sync output. String delta payloads (chat text slices) concatenate in
 * order into `text`; non-string payloads (tool-call fragments, structured
 * chunks) are collected in order into `parts`. Operation-typed assembly (true
 * tool-call 分片拼装 etc.) is a later slice / SPI aspect — it can replace this
 * helper WITHOUT touching the drain/settle plumbing around it.
 */
export function assembleStreamOutput(deltas: readonly unknown[]): unknown {
  const texts: string[] = [];
  const parts: unknown[] = [];
  for (const payload of deltas) {
    if (typeof payload === 'string') texts.push(payload);
    else parts.push(payload);
  }
  if (parts.length === 0) return { text: texts.join('') };
  if (texts.length === 0) return { parts };
  return { text: texts.join(''), parts };
}

/**
 * §3 sync × stream: pull the WHOLE stream and assemble a sync outcome.
 * Pre-commit degenerates into full-drain: no frame ever reaches the caller,
 * so an error frame at ANY position (first or mid-drain) is a plain dispatch
 * failure — eligible for §8 failover (已发帧禁整流重试 does not bind here,
 * nothing was delivered downstream).
 */
async function drainStreamToSync(handle: StreamRunHandle): Promise<SyncFetchOutcome> {
  const deltas: unknown[] = [];
  let usage: GatewayUsage | undefined;
  for await (const frame of handle.frames) {
    if (frame.kind === 'delta') {
      deltas.push(frame.payload);
    } else if (frame.kind === 'usage') {
      usage = frame.usage;
    } else if (frame.kind === 'done') {
      if (frame.usage !== undefined) usage = frame.usage;
      return { ok: true, output: assembleStreamOutput(deltas), usage: usage ?? EMPTY_USAGE };
    } else {
      return { ok: false, error: frame.error };
    }
  }
  // A 2xx open that ended without ANY terminal frame — a protocol violation.
  return {
    ok: false,
    error: {
      code: 'upstream_error',
      message: 'upstream stream ended without a terminal done frame',
      retryable: true,
      failover: true,
    },
  };
}

// --- §3 sync-over-submit block-poll ----------------------------------------------------------

interface BlockPollInput {
  dialect: Dialect;
  syncInput: SyncRunInput;
  pipeline: PipelineDeps;
  /** Poll budget seconds = min(model.max_run_time, offering budget) (§3). */
  budgetSeconds: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  /** The durable row (idempotent path) — the upstream handle/substate lands on it. */
  task?: TaskRow | undefined;
  tasks: GatewayTaskRepo;
  db: DbOrTx;
  /** §7.2 lease identity — the row's ORIGINAL owner (this request created it). */
  ownerNode: string;
  /** §7.2 lease horizon per in-request renewal. */
  leaseSeconds: number;
}

/**
 * §3 sync × submit_poll/submit_callback: 落可恢复模式 = 阻塞排流 — submit,
 * then a BOUNDED in-request poll loop to the terminal state, assembled as a
 * sync outcome. 择稳 rationale (vs demoting sync callers to failover errors):
 * this keeps §7.4 先落库/提交防重 IDENTICAL to the task paradigm (same
 * runTaskSubmit, same uncertain verdict) and serves the request. Single poll
 * failures are tolerated (§3 poll 单次失败重试不一错即败) — the budget bounds
 * the loop; adaptive backoff/jitter stays the slice4 worker's refinement. On
 * the idempotent path the upstream handle is recorded on the row FIRST, so a
 * crash mid-poll leaves a recoverable running row (slice4 lease takeover) —
 * and while THIS request is alive it renews its own lease before every probe
 * (§7.2 周期续租) so the takeover sweep never double-drives a healthy poll.
 */
async function submitAndBlockPoll(input: BlockPollInput): Promise<SyncFetchOutcome> {
  const submit = await runTaskSubmit(input.dialect, input.syncInput, input.pipeline);
  if (!submit.ok) {
    // §7.4 提交防重: a timeout is UNCERTAIN (the upstream MAY have created the
    // task but returned no handle) — marked for reconciliation and NEVER
    // re-submitted anywhere (宁可失败, uncertain blocks §8 failover too).
    const uncertain = submit.error.code === 'upstream_timeout';
    if (input.task !== undefined) {
      await input.tasks.transitionTask(input.db, input.task.id, ['running'], 'running', {
        internalSubstate: uncertain ? 'submit_uncertain' : 'submit_failed',
        eventPayload: { error: submit.error, uncertain },
      });
    }
    return { ok: false, error: submit.error, uncertain };
  }
  if (submit.kind === 'inline') {
    // The upstream completed synchronously under its own thresholds.
    return { ok: true, output: submit.output, usage: submit.usage };
  }
  if (input.task !== undefined) {
    await input.tasks.transitionTask(input.db, input.task.id, ['running'], 'running', {
      upstreamTaskId: submit.upstreamTaskId,
      internalSubstate: 'upstream_submitted',
      eventPayload: { upstreamTaskId: submit.upstreamTaskId },
    });
  }

  const probe = {
    upstreamTaskId: submit.upstreamTaskId,
    secret: input.syncInput.secret,
    ctx: input.syncInput.ctx,
  };
  const budgetMs = input.budgetSeconds * 1000;
  const deadline = input.nowMs() + budgetMs;
  // The attempt cap mirrors the wall-clock budget (and keeps the loop bounded
  // under injected/frozen clocks in tests).
  const maxPolls = Math.max(1, Math.ceil(budgetMs / input.intervalMs));
  for (let poll = 0; poll < maxPolls && input.nowMs() < deadline; poll++) {
    // §7.2 in-request 周期续租: this block-poll is the row's ORIGINAL lease
    // owner — renewing BEFORE every probe (the worker loop's exact discipline)
    // keeps `lease_until` ahead of the takeover sweep, so a budget > the lease
    // horizon can never be DOUBLE-driven (double poll + double persist). A
    // failed renew means the lease was LOST — 失主立即停手: no further
    // upstream call; the takeover node owns convergence now, and the error is
    // marked `uncertain` so §8 failover can never re-run the work elsewhere.
    if (input.task !== undefined) {
      const renewed = await input.tasks.renewTaskLease(
        input.db,
        input.task.id,
        input.ownerNode,
        new Date(input.nowMs() + input.leaseSeconds * 1000),
      );
      if (!renewed) {
        return {
          ok: false,
          error: {
            code: 'internal_error',
            message: `task ${input.task.id} lease was lost mid block-poll — another node took over; stopping without re-driving (§7.2 失主让位)`,
            retryable: false,
            failover: false,
          },
          uncertain: true,
        };
      }
    }
    const update = await runTaskQuery(input.dialect, probe, input.pipeline);
    if (update.ok) {
      const u = update.update;
      if (u.status === 'succeeded') {
        return { ok: true, output: u.output ?? null, usage: u.usage ?? EMPTY_USAGE };
      }
      if (u.status === 'failed' || u.status === 'canceled' || u.status === 'expired') {
        return {
          ok: false,
          error: u.error ?? {
            code: 'task_failed',
            message: `upstream task ${submit.upstreamTaskId} ended '${u.status}' without a normalized error`,
            retryable: false,
            failover: false,
          },
        };
      }
      // pending/running → keep polling.
    }
    // A single failed poll is tolerated (§3) — the budget bounds the loop.
    await input.sleep(Math.min(input.intervalMs, Math.max(0, deadline - input.nowMs())));
  }
  // Budget exhausted with the upstream still running: fail WITHOUT failover —
  // re-running a long job on a sibling would double the upstream work; on the
  // idempotent path the (failed) row remains the honest record.
  return {
    ok: false,
    error: {
      code: 'upstream_timeout',
      message: `upstream task ${submit.upstreamTaskId} did not reach a terminal state within ${String(input.budgetSeconds)}s`,
      retryable: false,
      failover: false,
    },
  };
}

// --- settle-input assembly ------------------------------------------------------------

type SettleBase = Omit<SettleGatewayResultInput, 'usage' | 'output' | 'task' | 'reservation'>;

function buildSettleBase(
  deps: ExecuteGatewayDeps,
  request: GatewayRequest,
  opts: ExecuteGatewayOptions,
  plan: PlanSuccess,
): SettleBase {
  return {
    tenantId: request.tenantId,
    accountId: opts.accountId,
    subjectId: request.subjectId ?? null,
    wallet: plan.reservation.holdTxn.wallet,
    holdAmount: plan.reservation.holdAmount,
    saleCardRef: plan.reservation.saleCardRef,
    costCardRef: plan.reservation.costCardRef,
    billingDims: plan.billingDims,
    upstreamInputs: plan.effective.upstream,
    modifiers: opts.modifiers ?? [],
    offeringId: plan.reservation.candidate.offering.id,
    persist: deps.persist,
    requirePersist: request.options.requirePersist,
    // §9.4 track hint: request-level override (tenant-policy-validated INSIDE
    // the hook, never silently honored) → model task default; the model's
    // declared signed-track retention rides along so row-less settles never
    // need a re-fetch.
    artifact: {
      mode: request.options.artifactMode ?? plan.model.artifact.mode,
      retentionDays: plan.model.artifact.retention_days,
    },
  };
}

// --- stream delivery helpers ------------------------------------------------------------

/** A fixed, already-settled frame sequence (stream×direct 优雅降级 delivery). */
async function* replayFrames(...frames: StreamFrame[]): AsyncGenerator<StreamFrame> {
  for (const frame of frames) {
    yield frame;
    await Promise.resolve();
  }
}

// --- stream drain-settle (§3 pre-commit tail) --------------------------------------------

interface SettlingStreamInput {
  frames: AsyncIterable<StreamFrame>;
  settleInput: SettleBase & { reservation: Reservation; task?: TaskRow | undefined };
}

/**
 * The engine-side settling stream: forward every normalized frame and settle
 * EXACTLY ONCE when the stream ends — on the terminal `done`, on a POST-commit
 * in-band `error` (→ fail/release, NO charge — 已发帧禁整流重试, the §7.8
 * rollback applies), and on consumer early-`return()` (disconnect → settle the
 * usage observed so far; none observed → the hold ceiling, §9.2 封顶 keeps it
 * bounded). The once-guard is local; the db transition guard (when a task row
 * rides along — the idempotent path) is the backstop.
 */
async function* settlingStream(
  settleDeps: GatewaySettleDeps,
  input: SettlingStreamInput,
): AsyncGenerator<StreamFrame> {
  let latestUsage: GatewayUsage | undefined;
  let failure: GatewayError | undefined;
  let finalized = false;

  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    if (failure !== undefined) {
      await failGatewayResult(settleDeps, {
        error: failure,
        task: input.settleInput.task,
        reservation: input.settleInput.reservation,
      });
      return;
    }
    await settleGatewayResult(settleDeps, {
      ...input.settleInput,
      usage: latestUsage ?? EMPTY_USAGE,
      output: null,
    });
  };

  try {
    for await (const frame of input.frames) {
      if (frame.kind === 'usage') latestUsage = frame.usage;
      if (frame.kind === 'done' && frame.usage !== undefined) latestUsage = frame.usage;
      if (frame.kind === 'error') failure = frame.error;
      yield frame;
      if (frame.kind === 'done' || frame.kind === 'error') break;
    }
  } finally {
    await finalize();
  }
}

// --- task paradigm (§7.1/§7.3/§7.4 + §3 at-most-once) --------------------------------------

interface TaskParadigmInput {
  plan: PlanSuccess;
  tasks: GatewayTaskRepo;
  dialect: Dialect;
  syncInput: SyncRunInput;
  pipeline: PipelineDeps;
  servedBy: ServedBy;
  base: ExecuteResultBase;
  settleBase: SettleBase;
  /** The durable row — already created (or §8-re-bound) and RUNNING. */
  taskRow: TaskRow;
  final: (result: ExecuteResult) => DispatchOutcome;
  abort: (error: GatewayError, task?: TaskRow) => Promise<DispatchOutcome>;
  dispatchFailed: (
    error: GatewayError,
    task: TaskRow | undefined,
    uncertain: boolean,
  ) => Promise<DispatchOutcome> | DispatchOutcome;
}

async function executeTaskParadigm(
  deps: ExecuteGatewayDeps,
  settleDeps: GatewaySettleDeps,
  input: TaskParadigmInput,
): Promise<DispatchOutcome> {
  const { plan, tasks, base, taskRow } = input;
  const { reservation, fetchPlan } = plan;

  if (fetchPlan.mode === 'stream') {
    // task over a live-stream upstream needs a worker drain (later slice) —
    // NOT inline-servable. The planner's §3 servability filter excludes it at
    // candidate assembly; this is the same DEFENSIVE assertion as
    // stream×submit above (terminal, releases the reservation, never spins
    // the §8 loop).
    return input.abort(
      internalError(
        `task paradigm reached dispatch over fetch mode 'stream' — the §3 servability filter must exclude this candidate before planning`,
      ),
      taskRow,
    );
  }

  // ── §3 at-most-once branch: fetch=direct — NO upstream handle exists. The
  //     202 answers now; the long-blocking runner (below) is driven by the
  //     caller/worker IN THIS PROCESS. A crash orphans the row as
  //     running+fetchMode=direct, which recovery (slice4) must fail WITHOUT
  //     charge and must NEVER re-submit. Runner failures never failover —
  //     the 202 already answered on THIS offering. ──────────────────────────
  if (fetchPlan.mode === 'direct') {
    const run = (): Promise<TaskRow | undefined> =>
      runDirectTask(settleDeps, {
        task: taskRow,
        reservation,
        dialect: input.dialect,
        syncInput: input.syncInput,
        pipeline: input.pipeline,
        settleBase: input.settleBase,
      });
    return input.final({
      kind: 'task',
      task: taskRow,
      status: 202,
      servedBy: input.servedBy,
      run,
      ...base,
    });
  }

  // ── submit_poll / submit_callback: §7.4 step 2 — call the upstream AFTER the
  //     durable row. ──────────────────────────────────────────────────────────
  const submit = await runTaskSubmit(input.dialect, input.syncInput, input.pipeline);
  if (!submit.ok) {
    // §7.4 提交防重: an uncertain outcome (timeout — the upstream MAY have
    // created the task but returned no handle) still fails: there is nothing
    // to query by (no upstreamTaskId), and blind re-submission — to THIS
    // upstream or (via §8 failover) any sibling — risks double execution.
    // 宁可失败. The substate marks it for reconciliation. A CERTAIN submit
    // rejection (clean non-2xx) may failover per its error flags.
    const uncertain = submit.error.code === 'upstream_timeout';
    await tasks.transitionTask(deps.db, taskRow.id, ['running'], 'running', {
      internalSubstate: uncertain ? 'submit_uncertain' : 'submit_failed',
      eventPayload: { error: submit.error, uncertain },
    });
    return input.dispatchFailed(submit.error, taskRow, uncertain);
  }

  if (submit.kind === 'inline') {
    // The upstream completed synchronously under its own thresholds: settle now
    // (转存 hook included) and answer the already-terminal task.
    const settled = await settleGatewayResult(settleDeps, {
      ...input.settleBase,
      usage: submit.usage,
      output: submit.output,
      task: taskRow,
      reservation,
    });
    if (!settled.ok) return input.final({ kind: 'error', error: settled.error, ...base });
    return input.final({
      kind: 'task',
      task: settled.task ?? taskRow,
      status: 202,
      servedBy: input.servedBy,
      ...base,
    });
  }

  // Upstream handle in hand — record it (§7 correlation key for poll/callback/
  // lease takeover) and answer 202. Poll/settle is the slice4 worker; the hold
  // stays (it settles or rolls back at the task's terminal transition). The
  // admission SLOT is released — it gated the submit window; in-flight task
  // concurrency accounting across nodes is the quota mirror's, not an
  // in-process slot's.
  const submitted = await tasks.transitionTask(deps.db, taskRow.id, ['running'], 'running', {
    upstreamTaskId: submit.upstreamTaskId,
    internalSubstate: 'upstream_submitted',
    eventPayload: { upstreamTaskId: submit.upstreamTaskId },
  });
  try {
    await reservation.slot.release();
  } catch {
    // best-effort — a leaked slot self-heals via the counter TTL
  }
  return input.final({
    kind: 'task',
    task: submitted ?? taskRow,
    status: 202,
    servedBy: input.servedBy,
    ...base,
  });
}

/** The model's default artifact mode (§9.4 产物双轨) — request override wins upstreamly. */
function modelArtifactMode(model: SupplyModelRow): string | null {
  return model.artifact.mode;
}

// --- direct-task runner (§3 at-most-once long-blocking execution) ---------------------------

export interface DirectTaskRunInput {
  task: TaskRow;
  reservation: Reservation;
  dialect: Dialect;
  syncInput: SyncRunInput;
  pipeline: PipelineDeps;
  settleBase: SettleBase;
}

/**
 * The §3 at-most-once long-blocking execution for a fetch=direct task: ONE
 * buffered upstream call (runSync), then settle → succeeded, or fail →
 * failed + `reservation.release()` (hold rolled back — NO charge, the platform
 * absorbs the upstream cost). There is NO retry and NO re-submission surface
 * here by construction; a crash mid-flight leaves running+direct for recovery
 * to fail (slice4), never to re-drive.
 */
export async function runDirectTask(
  settleDeps: GatewaySettleDeps,
  input: DirectTaskRunInput,
): Promise<TaskRow | undefined> {
  let run: Awaited<ReturnType<typeof runSync>>;
  try {
    run = await runSync(input.dialect, input.syncInput, input.pipeline);
  } catch (err) {
    run = {
      ok: false,
      error: internalError(
        `direct task execution threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  if (!run.ok) {
    const failed = await failGatewayResult(settleDeps, {
      error: run.error,
      task: input.task,
      reservation: input.reservation,
    });
    return failed.task;
  }
  const settled = await settleGatewayResult(settleDeps, {
    ...input.settleBase,
    usage: run.usage,
    output: run.output,
    task: input.task,
    reservation: input.reservation,
  });
  return settled.ok ? settled.task : undefined;
}
