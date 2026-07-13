// packages/engine/src/gateway/task-recovery.ts
//
// model-supply-greenfield 批次4 slice4 — TASK RELIABILITY: the worker-side
// poll/lease-recovery engine (§7.2/§7.4/§3) + the shared TaskUpdate fold the
// callback ingress reuses (§3 双保险 — callback fast path and poll backstop
// write through the SAME funnel, deduped by the transitionTask from-guard).
//
// Red lines this module OWNS:
//
//   §7.2 租约恢复只承诺 submit_poll / submit_callback: the takeover feed
//        (listRecoverableTasksForTakeover) is SQL-restricted to those modes;
//        `claimTaskLease` is the atomic race arbiter; the poll loop renews the
//        lease BEFORE every probe and STOPS INSTANTLY on renew=false (失主
//        立即停手 — no settle, no fail, no further upstream call).
//   §3   direct 至多一次: this module NEVER imports runTaskSubmit — there is
//        no re-submission surface here BY CONSTRUCTION. Orphaned direct rows
//        (running ∩ fetch=direct ∩ hold expired) are FAILED without charge
//        (platform absorbs the upstream cost), never taken over, never
//        re-driven.
//   §7.4 提交防重: a taken-over row WITH an upstream handle resumes polling
//        directly (the submit already happened — 先落库再调上游 makes the row
//        the proof); a row WITHOUT a handle (submit_uncertain, or a crash in
//        the submit window) has nothing to query by and is failed WITHOUT
//        charge — 宁可失败不盲目重提.
//   §7.3 hold-expiry backstop: any live task past `hold_expires_at` (poll
//        budget long gone, nobody recovered it) fails with the hold released
//        and ZERO charge; the poll loop itself also caps its deadline at
//        min(startedAt + max_run_time, hold_expires_at).
//
// Settle inputs are RECONSTRUCTED from the task row (slice2 contract): wallet
// from the hold columns, billingDims / EffectiveParams / modifiers from the
// `inputs` IR envelope, price-card refs from the row snapshots — so a task
// settles identically whether its request-scoped context survived or not.
import type {
  ArtifactMode,
  BillingDims,
  CredentialSecret,
  EffectiveParams,
  GatewayError,
  GatewayUsage,
  HttpClient,
  Modifier,
  TaskUpdate,
} from '@actionow/contracts';
import type { DbOrTx, SupplyChannelRow, SupplyOfferingRow, TaskRow } from '@actionow/db';
import {
  claimTaskLease,
  getSupplyChannelById,
  getSupplyOfferingById,
  getSupplyProviderById,
  getTaskById,
  listActiveCredentialsForChannel,
  listExpiredHoldGatewayTasks,
  listOrphanedDirectTasks,
  listRecoverableTasksForTakeover,
  renewTaskLease,
  resolveSupplyCredentialSecret,
  transitionTask,
} from '@actionow/db';
import type { Dialect, DialectContext, DialectRegistry, PipelineDeps } from '@actionow/spi';
// RED LINE (§7.4/§3): runTaskQuery ONLY — runTaskSubmit is deliberately not
// imported; recovery can never re-submit, no matter the code path.
import { runTaskQuery } from '@actionow/spi';

import { resolveDialectForOffering } from './dialect-resolve.js';
import type { GatewaySettleDeps, GatewaySettleRepo, PersistHook } from './settle-task.js';
import { failGatewayResult, settleGatewayResult } from './settle-task.js';
import type { TaskWebhookEmitter } from './task-webhook.js';
import { emitTaskWebhookBestEffort } from './task-webhook.js';

// --- defaults --------------------------------------------------------------------

/** §7.2 lease horizon per renewal (matches the gateway's DEFAULT_LEASE_SECONDS). */
export const DEFAULT_RECOVERY_LEASE_SECONDS = 60;
/** Adaptive poll cadence bounds (§3 自适应退避+抖动). */
export const DEFAULT_POLL_BASE_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_MAX_INTERVAL_MS = 15_000;
/** Per-probe transport budget — a poll is a short status read, never the run budget. */
export const DEFAULT_POLL_PROBE_TIMEOUT_MS = 30_000;
/** Fallback run budget when a row carries no max_run_time (mirrors execute.ts). */
export const DEFAULT_RECOVERY_MAX_RUN_SECONDS = 3_600;
/** Takeover / reap batch size per sweep. */
export const DEFAULT_RECOVERY_BATCH_SIZE = 50;

// --- deps ------------------------------------------------------------------------

/** The slice1 task-repo surface recovery drives (injectable). */
export interface TaskRecoveryRepo {
  listRecoverableTasksForTakeover: typeof listRecoverableTasksForTakeover;
  claimTaskLease: typeof claimTaskLease;
  renewTaskLease: typeof renewTaskLease;
  getTaskById: typeof getTaskById;
  transitionTask: typeof transitionTask;
  listOrphanedDirectTasks: typeof listOrphanedDirectTasks;
  listExpiredHoldGatewayTasks: typeof listExpiredHoldGatewayTasks;
}

/** The supply reads the poll context needs (injectable). */
export interface TaskRecoveryQueries {
  getSupplyOfferingById: typeof getSupplyOfferingById;
  getSupplyChannelById: typeof getSupplyChannelById;
  getSupplyProviderById: typeof getSupplyProviderById;
  listActiveCredentialsForChannel: typeof listActiveCredentialsForChannel;
  resolveSupplyCredentialSecret: typeof resolveSupplyCredentialSecret;
}

export interface TaskRecoveryDeps {
  db: DbOrTx;
  /** The versioned SPI dialect registry (§6). */
  dialectRegistry: DialectRegistry;
  /** The HttpClient the SPI pipeline transports over (§6-④). */
  spiHttp: HttpClient;
  /** This node's lease identity (§7.2 owner_node). */
  ownerNode: string;
  now?: (() => Date) | undefined;
  nowMs?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Uniform RNG in [0,1) — poll jitter; default Math.random. */
  rng?: (() => number) | undefined;
  leaseSeconds?: number | undefined;
  pollBaseIntervalMs?: number | undefined;
  pollMaxIntervalMs?: number | undefined;
  pollProbeTimeoutMs?: number | undefined;
  defaultMaxRunSeconds?: number | undefined;
  batchSize?: number | undefined;
  /** Resolve a channel's proxy_ref to an egress proxy URL; absent → direct egress. */
  resolveProxyUrl?: ((proxyRef: string) => Promise<string | undefined>) | undefined;
  /** §7.5 artifact persistence hook (slice5 provides the real one). */
  persist?: PersistHook | undefined;
  /** §7.6 emitter override (tests); absent → production emitter. */
  emitTaskWebhook?: TaskWebhookEmitter | undefined;
  repo?: Partial<TaskRecoveryRepo> | undefined;
  queries?: Partial<TaskRecoveryQueries> | undefined;
  settleRepo?: Partial<GatewaySettleRepo> | undefined;
}

function repoOf(deps: TaskRecoveryDeps): TaskRecoveryRepo {
  return {
    listRecoverableTasksForTakeover:
      deps.repo?.listRecoverableTasksForTakeover ?? listRecoverableTasksForTakeover,
    claimTaskLease: deps.repo?.claimTaskLease ?? claimTaskLease,
    renewTaskLease: deps.repo?.renewTaskLease ?? renewTaskLease,
    getTaskById: deps.repo?.getTaskById ?? getTaskById,
    transitionTask: deps.repo?.transitionTask ?? transitionTask,
    listOrphanedDirectTasks: deps.repo?.listOrphanedDirectTasks ?? listOrphanedDirectTasks,
    listExpiredHoldGatewayTasks:
      deps.repo?.listExpiredHoldGatewayTasks ?? listExpiredHoldGatewayTasks,
  };
}

function queriesOf(deps: TaskRecoveryDeps): TaskRecoveryQueries {
  return {
    getSupplyOfferingById: deps.queries?.getSupplyOfferingById ?? getSupplyOfferingById,
    getSupplyChannelById: deps.queries?.getSupplyChannelById ?? getSupplyChannelById,
    getSupplyProviderById: deps.queries?.getSupplyProviderById ?? getSupplyProviderById,
    listActiveCredentialsForChannel:
      deps.queries?.listActiveCredentialsForChannel ?? listActiveCredentialsForChannel,
    resolveSupplyCredentialSecret:
      deps.queries?.resolveSupplyCredentialSecret ?? resolveSupplyCredentialSecret,
  };
}

function settleDepsOf(deps: {
  db: DbOrTx;
  settleRepo?: Partial<GatewaySettleRepo> | undefined;
  emitTaskWebhook?: TaskWebhookEmitter | undefined;
  repo?: Partial<TaskRecoveryRepo> | undefined;
}): GatewaySettleDeps {
  return {
    db: deps.db,
    // An injected transitionTask (tests) drives the settle/fail funnels too —
    // the executeGateway wiring discipline.
    repo: {
      ...(deps.repo?.transitionTask !== undefined
        ? { transitionTask: deps.repo.transitionTask }
        : {}),
      ...deps.settleRepo,
    },
    ...(deps.emitTaskWebhook !== undefined ? { emitTaskWebhook: deps.emitTaskWebhook } : {}),
  };
}

const EMPTY_USAGE: GatewayUsage = { metrics: {}, billingDims: {}, estimated: true };

// --- settle-input reconstruction (the slice2 contract) ------------------------------

/** The `inputs` IR envelope shape execute.ts stamps at create (slice2). */
interface TaskInputsEnvelope {
  effective?: EffectiveParams;
  billingDims?: BillingDims;
  modifiers?: Modifier[];
  options?: { requirePersist?: boolean };
}

/**
 * A sale-card snapshot ref that NEVER resolves (nil uuid): when a row somehow
 * lacks its §9.2 snapshot, settle degrades to the hold-ceiling charge (the
 * settle path's `sale_card_missing` arm) instead of serving free — 钱账红线.
 */
const NIL_CARD_REF = { cardId: '00000000-0000-0000-0000-000000000000', version: 0 } as const;

type ReconstructedSettleBase = Omit<
  Parameters<typeof settleGatewayResult>[1],
  'usage' | 'output' | 'task' | 'reservation'
>;

/**
 * Rebuild the settle inputs from the durable row alone (slice2 contract:
 * wallet 从 task 列重建, billingDims/effective/modifiers 从 inputs 信封读,
 * 卡引用从 saleCardRef/costCardRef). `undefined` ⇔ the row lacks account
 * attribution OR a hold amount (data anomaly) — the caller must fail, not
 * settle. holdAmount is NEVER defaulted to 0n: settle is hold-CAPPED (§9.2
 * 封顶), so a silent 0 would cap the charge at zero and ship the succeeded
 * work FREE (漏收) — the same strictness as the accountId guard. A real 0n
 * hold (free-priced admission) passes through untouched.
 */
export function reconstructSettleBase(
  task: TaskRow,
  persist?: PersistHook,
): ReconstructedSettleBase | undefined {
  if (task.accountId === null) return undefined;
  if (task.holdAmount === null) return undefined;
  const inputs = task.inputs as TaskInputsEnvelope;
  return {
    tenantId: task.tenantId,
    accountId: task.accountId,
    subjectId: task.subjectId,
    wallet:
      task.subAccountId !== null
        ? { kind: 'subject', subAccountId: task.subAccountId }
        : { kind: 'tenant', accountId: task.accountId, tenantId: task.tenantId },
    holdAmount: task.holdAmount,
    saleCardRef:
      task.saleCardRef !== null
        ? { cardId: task.saleCardRef.card_id, version: task.saleCardRef.version }
        : NIL_CARD_REF,
    costCardRef:
      task.costCardRef !== null
        ? { cardId: task.costCardRef.card_id, version: task.costCardRef.version }
        : null,
    billingDims: inputs.billingDims ?? {},
    upstreamInputs: inputs.effective?.upstream ?? {},
    modifiers: inputs.modifiers ?? [],
    offeringId: task.offeringId ?? 'unknown',
    ...(persist !== undefined ? { persist } : {}),
    requirePersist: inputs.options?.requirePersist,
    // §9.4 track hint from the row's create-time stamp (request override ??
    // model default, execute.ts). Retention is deliberately ABSENT — the hook
    // re-resolves it from the model row / platform default at settle time.
    artifact: { mode: task.artifactMode as ArtifactMode | null },
  };
}

// --- applyTaskUpdate: THE shared TaskUpdate fold (§3 双保险 single funnel) ------------

export interface ApplyTaskUpdateDeps {
  db: DbOrTx;
  settleRepo?: Partial<GatewaySettleRepo> | undefined;
  transitionTask?: typeof transitionTask | undefined;
  persist?: PersistHook | undefined;
  emitTaskWebhook?: TaskWebhookEmitter | undefined;
}

export type ApplyTaskUpdateOutcome =
  /** The settle transaction moved the row → succeeded + charged exactly once. */
  | { kind: 'settled'; task?: TaskRow | undefined }
  /** Terminal failure written (hold released, no charge). */
  | { kind: 'failed'; task?: TaskRow | undefined }
  | { kind: 'canceled'; task?: TaskRow | undefined }
  /** Progress/substate observation written on the still-running row. */
  | { kind: 'progress'; task?: TaskRow | undefined }
  /** Nothing meaningful to write (same progress re-observed). */
  | { kind: 'noop' }
  /** From-guard no-op — ANOTHER writer already terminalized (双保险 dedup). */
  | { kind: 'stale' };

const APPLY_TERMINAL_KINDS: ReadonlySet<ApplyTaskUpdateOutcome['kind']> = new Set([
  'settled',
  'failed',
  'canceled',
]);

/** Is this outcome a terminal write (the caller can stop driving the task)? */
export function isTerminalApplyOutcome(outcome: ApplyTaskUpdateOutcome): boolean {
  return APPLY_TERMINAL_KINDS.has(outcome.kind) || outcome.kind === 'stale';
}

/**
 * Fold ONE normalized {@link TaskUpdate} (poll observation OR verified
 * callback) into the canonical task state machine. This is the §3 双保险
 * convergence point: the callback fast path and the poll backstop both call
 * here, and the transitionTask from-guard (inside settle/fail) guarantees
 * exactly ONE terminal write no matter how many observers race — the losers
 * see `stale`.
 *
 * - succeeded → settleGatewayResult (§9.2 双卡, hold-capped, price snapshots;
 *   §7.5 persist hook runs BEFORE the money moves).
 * - failed / canceled / expired → failGatewayResult (hold released, NO charge).
 * - pending / running → progress/substate observation (乱序容忍: a stale
 *   in-flight update NEVER fails the task; on an already-terminal row the
 *   from-guard no-ops it away).
 */
export async function applyTaskUpdate(
  deps: ApplyTaskUpdateDeps,
  task: TaskRow,
  update: TaskUpdate,
  source: 'poll' | 'callback',
): Promise<ApplyTaskUpdateOutcome> {
  // An injected transitionTask (tests / execute.ts parity) must drive the
  // settle/fail funnels too — same wiring discipline as executeGateway's.
  const settleDeps: GatewaySettleDeps = {
    db: deps.db,
    repo: {
      ...(deps.transitionTask !== undefined ? { transitionTask: deps.transitionTask } : {}),
      ...deps.settleRepo,
    },
    ...(deps.emitTaskWebhook !== undefined ? { emitTaskWebhook: deps.emitTaskWebhook } : {}),
  };

  if (update.status === 'succeeded') {
    const base = reconstructSettleBase(task, deps.persist);
    if (base === undefined) {
      // Data anomaly (no account attribution / no hold amount) — cannot
      // price: a missing wallet cannot be invented, and a missing hold would
      // 0-cap the charge and ship the work FREE (§9.2 不免费出货). Fail
      // terminally WITHOUT charge (宁可失败) — the internal_error envelope +
      // task_events row + §7.6 task.failed webhook are the alarm surface;
      // leaving the row running would just re-poll the anomaly forever.
      const anomaly =
        task.accountId === null
          ? 'no account attribution'
          : 'no hold amount (charge ceiling unknown)';
      const failed = await failGatewayResult(settleDeps, {
        error: {
          code: 'internal_error',
          message: `task ${task.id} succeeded upstream but carries ${anomaly} — cannot settle (failed without charge, never free)`,
          retryable: false,
          failover: false,
        },
        task,
      });
      return failed.failed ? { kind: 'failed', task: failed.task } : { kind: 'stale' };
    }
    const settled = await settleGatewayResult(settleDeps, {
      ...base,
      usage: update.usage ?? EMPTY_USAGE,
      output: update.output ?? null,
      task,
    });
    if (!settled.ok) {
      // required-persist failure — settleGatewayResult already ran the fail
      // path (terminal transition + hold release, §7.5 失败即 fail 不扣费).
      return { kind: 'failed' };
    }
    return settled.settled ? { kind: 'settled', task: settled.task } : { kind: 'stale' };
  }

  if (update.status === 'failed' || update.status === 'canceled' || update.status === 'expired') {
    const to = update.status === 'canceled' ? 'canceled' : 'failed';
    const error: GatewayError = update.error ?? {
      code: 'task_failed',
      message: `upstream task ${update.upstreamTaskId} ended '${update.status}'${update.rawStatus !== undefined ? ` (raw: ${update.rawStatus})` : ''} without a normalized error`,
      retryable: false,
      failover: false,
    };
    const failed = await failGatewayResult(settleDeps, { error, task, to });
    if (!failed.failed) return { kind: 'stale' };
    return to === 'canceled'
      ? { kind: 'canceled', task: failed.task }
      : { kind: 'failed', task: failed.task };
  }

  // pending / running — 乱序容忍: an in-flight observation NEVER fails the
  // task. Write only when the progress value actually moved (poll cadence
  // would otherwise spam task_events); the from-guard drops it silently when
  // another writer already terminalized (late/out-of-order arrival).
  const progress = update.progress !== undefined ? Math.round(update.progress) : undefined;
  if (progress === undefined || progress === task.progress) return { kind: 'noop' };
  const doTransition = deps.transitionTask ?? transitionTask;
  const moved = await doTransition(deps.db, task.id, ['pending', 'running'], 'running', {
    progress,
    internalSubstate: `upstream_${update.status}`,
    eventPayload: {
      source,
      progress,
      ...(update.rawStatus !== undefined ? { rawStatus: update.rawStatus } : {}),
    },
  });
  if (moved === undefined) return { kind: 'stale' };
  await emitTaskWebhookBestEffort(
    { db: deps.db, emit: deps.emitTaskWebhook },
    moved,
    'task.progress',
  );
  return { kind: 'progress', task: moved };
}

// --- poll context (offering → dialect + credential, §2.4 pool) ------------------------

export interface PollContext {
  dialect: Dialect;
  ctx: DialectContext;
  secret: CredentialSecret;
  pipeline: PipelineDeps;
  offering: SupplyOfferingRow;
  channel: SupplyChannelRow;
}

export type ResolvePollContextResult =
  | { ok: true; context: PollContext }
  | { ok: false; reason: string };

/**
 * Resolve everything a poll probe needs from the durable row: offering →
 * channel → provider → dialect (§2.2/§2.3 fallback chain) + a credential
 * drawn from the channel's ACTIVE pool (§2.4 — poll calls re-sign, any pool
 * key of the channel may query; the original submit key may be cooling).
 * EVERY failure here is answered as a DEFERRAL, never a task failure: the
 * lease simply lapses and the next sweep retries, with the §7.3 hold-expiry
 * backstop as the terminal guarantee — a transient pool cooldown or deploy
 * drift must not fail (and un-charge) real upstream work.
 */
export async function resolvePollContext(
  deps: TaskRecoveryDeps,
  task: TaskRow,
): Promise<ResolvePollContextResult> {
  const queries = queriesOf(deps);
  const now = deps.now ?? ((): Date => new Date());
  if (task.offeringId === null) return { ok: false, reason: 'task has no offering attribution' };
  const offering = await queries.getSupplyOfferingById(deps.db, task.offeringId);
  if (offering === undefined) return { ok: false, reason: `offering ${task.offeringId} not found` };
  const channel = await queries.getSupplyChannelById(deps.db, offering.channelId);
  if (channel === undefined)
    return { ok: false, reason: `channel ${offering.channelId} not found` };
  const provider = await queries.getSupplyProviderById(deps.db, channel.providerId);
  const resolved = resolveDialectForOffering(
    { registry: deps.dialectRegistry },
    {
      channel,
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
  if (!resolved.ok) return { ok: false, reason: resolved.error.message };

  const pool = await queries.listActiveCredentialsForChannel(deps.db, channel.id, now());
  const credential = pool[0];
  if (credential === undefined) {
    return { ok: false, reason: `channel ${channel.id} credential pool is empty/cooling` };
  }
  const secret = await queries.resolveSupplyCredentialSecret(deps.db, credential.id);
  if (secret === undefined) {
    return { ok: false, reason: `credential ${credential.id} secret unresolvable` };
  }

  const proxyUrl =
    channel.proxyRef !== null && deps.resolveProxyUrl !== undefined
      ? await deps.resolveProxyUrl(channel.proxyRef)
      : undefined;
  const pipeline: PipelineDeps = {
    http: deps.spiHttp,
    budget: { totalTimeoutMs: deps.pollProbeTimeoutMs ?? DEFAULT_POLL_PROBE_TIMEOUT_MS },
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
  };
  return {
    ok: true,
    context: { dialect: resolved.dialect, ctx: resolved.ctx, secret, pipeline, offering, channel },
  };
}

// --- the poll loop (§3 submit_poll strategy; submit_callback's 兜底轮询) ----------------

export type RecoverTaskOutcome =
  | { kind: 'settled'; task?: TaskRow | undefined }
  | { kind: 'failed'; task?: TaskRow | undefined }
  | { kind: 'canceled'; task?: TaskRow | undefined }
  /** Budget exhausted → failed(upstream_timeout), hold released, no charge. */
  | { kind: 'timeout'; task?: TaskRow | undefined }
  /** hold_expires_at already lapsed at takeover → failed, no charge. */
  | { kind: 'expired_hold'; task?: TaskRow | undefined }
  /** §7.4: no upstream handle to reconcile by → failed, no charge, NO re-submit. */
  | { kind: 'uncertain_failed'; task?: TaskRow | undefined }
  /** Lease lost to another node mid-poll → stopped INSTANTLY, nothing written. */
  | { kind: 'lease_lost' }
  /** Another writer terminalized the row (callback fast path won) — nothing to do. */
  | { kind: 'stale' }
  /** Transient context failure (pool cooling / config read) — retry next sweep. */
  | { kind: 'deferred'; reason: string };

function timeoutError(task: TaskRow, budgetSeconds: number): GatewayError {
  return {
    code: 'upstream_timeout',
    message: `task ${task.id} did not reach a terminal state within its ${String(budgetSeconds)}s budget (recovery poll)`,
    retryable: false,
    failover: false,
  };
}

/**
 * Drive one RECOVERABLE task (upstream handle in hand) to a terminal state:
 * renew-lease → probe → fold, with adaptive backoff + jitter (§3 自适应退避;
 * a SINGLE failed probe is tolerated — 单次失败重试不一错即败, the budget
 * bounds the loop). Deadline = min(start + max_run_time, hold_expires_at);
 * exhaustion fails WITHOUT charge (§7.3 口径 — the §7.8 hold rolls back).
 */
export async function pollTaskToTerminal(
  deps: TaskRecoveryDeps,
  context: PollContext,
  task: TaskRow,
): Promise<RecoverTaskOutcome> {
  if (task.upstreamTaskId === null) {
    return { kind: 'deferred', reason: 'pollTaskToTerminal requires an upstream handle' };
  }
  const repo = repoOf(deps);
  const nowMs = deps.nowMs ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const rng = deps.rng ?? Math.random;
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_RECOVERY_LEASE_SECONDS;
  const baseMs = deps.pollBaseIntervalMs ?? DEFAULT_POLL_BASE_INTERVAL_MS;
  const maxMs = deps.pollMaxIntervalMs ?? DEFAULT_POLL_MAX_INTERVAL_MS;
  const settleDeps = settleDepsOf(deps);

  const budgetSeconds =
    task.maxRunTimeSeconds ?? deps.defaultMaxRunSeconds ?? DEFAULT_RECOVERY_MAX_RUN_SECONDS;
  const anchorMs = (task.startedAt ?? task.createdAt).getTime();
  let deadlineMs = anchorMs + budgetSeconds * 1000;
  if (task.holdExpiresAt !== null) deadlineMs = Math.min(deadlineMs, task.holdExpiresAt.getTime());

  const probe = { upstreamTaskId: task.upstreamTaskId, secret: context.secret, ctx: context.ctx };
  let current = task;
  let intervalMs = baseMs;

  while (nowMs() < deadlineMs) {
    // §7.2 失主立即停手: renew BEFORE every probe; a lost lease means another
    // node owns this task NOW — stop without any write or upstream call.
    const renewed = await repo.renewTaskLease(
      deps.db,
      task.id,
      deps.ownerNode,
      new Date(nowMs() + leaseSeconds * 1000),
    );
    if (!renewed) return { kind: 'lease_lost' };

    const res = await runTaskQuery(context.dialect, probe, context.pipeline);
    if (res.ok) {
      const outcome = await applyTaskUpdate(
        {
          db: deps.db,
          settleRepo: deps.settleRepo,
          transitionTask: deps.repo?.transitionTask,
          persist: deps.persist,
          emitTaskWebhook: deps.emitTaskWebhook,
        },
        current,
        res.update,
        'poll',
      );
      if (outcome.kind === 'settled' || outcome.kind === 'failed' || outcome.kind === 'canceled') {
        return outcome;
      }
      if (outcome.kind === 'stale') return { kind: 'stale' };
      if (outcome.kind === 'progress' && outcome.task !== undefined) current = outcome.task;
      intervalMs = Math.min(Math.round(intervalMs * 1.5), maxMs); // adaptive backoff
    } else {
      // §3 poll 单次失败重试不一错即败 — back off harder and keep going; the
      // deadline bounds the loop.
      intervalMs = Math.min(intervalMs * 2, maxMs);
    }
    const jitter = 1 + (rng() - 0.5) * 0.2; // ±10%
    const waitMs = Math.max(0, Math.min(Math.round(intervalMs * jitter), deadlineMs - nowMs()));
    await sleep(waitMs);
  }

  const failed = await failGatewayResult(settleDeps, {
    error: timeoutError(task, budgetSeconds),
    task: current,
  });
  return failed.failed ? { kind: 'timeout', task: failed.task } : { kind: 'stale' };
}

/**
 * Recover ONE claimed task (the lease is already ours). Decision ladder:
 *
 * 1. hold already expired → fail (timeout), hold released, NO charge — the
 *    §7.3 backstop applied inline rather than waiting for the reaper.
 * 2. upstream handle present → resume polling (§7.4: the durable handle IS
 *    the proof the submit happened — 直接轮询, never re-submit).
 * 3. no handle (submit_uncertain / crash inside the submit window) → there is
 *    NOTHING to query by; §7.4 宁可失败不盲目重提 — fail WITHOUT charge.
 */
export async function recoverClaimedTask(
  deps: TaskRecoveryDeps,
  task: TaskRow,
): Promise<RecoverTaskOutcome> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const settleDeps = settleDepsOf(deps);

  if (task.holdExpiresAt !== null && task.holdExpiresAt.getTime() <= now.getTime()) {
    const failed = await failGatewayResult(settleDeps, {
      error: {
        code: 'upstream_timeout',
        message: `task ${task.id} hold expired before reaching a terminal state (recovery takeover)`,
        retryable: false,
        failover: false,
      },
      task,
    });
    return failed.failed ? { kind: 'expired_hold', task: failed.task } : { kind: 'stale' };
  }

  if (task.upstreamTaskId !== null) {
    const context = await resolvePollContext(deps, task);
    if (!context.ok) return { kind: 'deferred', reason: context.reason };
    return pollTaskToTerminal(deps, context.context, task);
  }

  // §7.4: no upstream handle. `submit_uncertain` marked or not, the story is
  // the same — the submit MAY have landed upstream, but with no handle there
  // is nothing to query/confirm by, and re-submitting risks double execution
  // (and double upstream cost). Fail terminally, release the hold, charge
  // nothing; the platform absorbs any orphaned upstream cost (§3 口径).
  const uncertain = task.internalSubstate === 'submit_uncertain';
  const failed = await failGatewayResult(settleDeps, {
    error: {
      code: uncertain ? 'upstream_timeout' : 'task_failed',
      message: uncertain
        ? `task ${task.id} submit outcome is uncertain and no upstream handle exists to reconcile — failing without re-submission (§7.4 宁可失败)`
        : `task ${task.id} was orphaned before an upstream handle was recorded — failing without re-submission (§7.4)`,
      retryable: false,
      failover: false,
    },
    task,
  });
  return failed.failed ? { kind: 'uncertain_failed', task: failed.task } : { kind: 'stale' };
}

// --- the takeover sweep (§7.2) ---------------------------------------------------------

export interface RecoverySweepSummary {
  scanned: number;
  claimed: number;
  outcomes: Record<RecoverTaskOutcome['kind'], number>;
}

function emptyOutcomes(): RecoverySweepSummary['outcomes'] {
  return {
    settled: 0,
    failed: 0,
    canceled: 0,
    timeout: 0,
    expired_hold: 0,
    uncertain_failed: 0,
    lease_lost: 0,
    stale: 0,
    deferred: 0,
  };
}

/**
 * The §7.2 takeover sweep: pull expired/never-leased RECOVERABLE running
 * tasks (submit_poll / submit_callback ONLY — the repo query enforces the
 * scope), race `claimTaskLease` per row (exactly one contender wins), re-read
 * the row post-claim (a late submit thread may have recorded the handle in
 * the gap), then drive it via {@link recoverClaimedTask}. Tasks are driven
 * SEQUENTIALLY within one sweep — the sweep cadence + batch size bound the
 * work; parallel takeover is a later optimization, not a correctness need.
 */
export async function sweepRecoverableTasks(deps: TaskRecoveryDeps): Promise<RecoverySweepSummary> {
  const repo = repoOf(deps);
  const now = deps.now ?? ((): Date => new Date());
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_RECOVERY_LEASE_SECONDS;
  const due = await repo.listRecoverableTasksForTakeover(
    deps.db,
    now(),
    deps.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE,
  );
  const summary: RecoverySweepSummary = {
    scanned: due.length,
    claimed: 0,
    outcomes: emptyOutcomes(),
  };

  for (const stale of due) {
    const claimed = await repo.claimTaskLease(
      deps.db,
      stale.id,
      deps.ownerNode,
      new Date(now().getTime() + leaseSeconds * 1000),
    );
    if (!claimed) continue; // another node won the race — its task now
    summary.claimed += 1;
    const fresh = (await repo.getTaskById(deps.db, stale.id)) ?? stale;
    if (fresh.status !== 'running') {
      summary.outcomes.stale += 1; // terminalized between list and claim
      continue;
    }
    const outcome = await recoverClaimedTask(deps, fresh);
    summary.outcomes[outcome.kind] += 1;
  }
  return summary;
}

// --- reapers: §3 direct orphans + §7.3 expired holds -------------------------------------

/** What one reap pass did. */
export interface ReapSummary {
  scanned: number;
  failed: number;
}

/**
 * §3 direct-orphan sweep (slice2 handoff): running ∩ fetch=direct ∩ hold
 * expired → failed WITHOUT charge. AT-MOST-ONCE by construction: there is no
 * upstream handle, no lease, no takeover, no re-submission — the row is
 * terminally failed and the platform absorbs whatever the upstream did. The
 * from-guard inside failGatewayTask makes racing writers (an in-process
 * runner finishing late) converge on exactly one terminal write.
 */
export async function reapOrphanedDirectTasks(
  deps: TaskRecoveryDeps,
  now: Date,
): Promise<ReapSummary> {
  const repo = repoOf(deps);
  const settleDeps = settleDepsOf(deps);
  const rows = await repo.listOrphanedDirectTasks(
    deps.db,
    now,
    deps.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE,
  );
  let failed = 0;
  for (const row of rows) {
    const r = await failGatewayResult(settleDeps, {
      error: {
        code: 'task_failed',
        message: `direct task ${row.id} was orphaned (worker crash) — failed without charge, never re-submitted (§3 至多一次)`,
        retryable: false,
        failover: false,
      },
      task: row,
    });
    if (r.failed) failed += 1;
  }
  return { scanned: rows.length, failed };
}

/**
 * §7.3 hold-expiry backstop for NON-direct gateway tasks: pending/running rows
 * past `hold_expires_at` that neither their driver nor the takeover sweep
 * terminalized → failed(upstream_timeout), hold released, NO charge. This is
 * the terminal guarantee under every deferral above.
 */
export async function reapExpiredHoldGatewayTasks(
  deps: TaskRecoveryDeps,
  now: Date,
): Promise<ReapSummary> {
  const repo = repoOf(deps);
  const settleDeps = settleDepsOf(deps);
  const rows = await repo.listExpiredHoldGatewayTasks(
    deps.db,
    now,
    deps.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE,
  );
  let failed = 0;
  for (const row of rows) {
    const r = await failGatewayResult(settleDeps, {
      error: {
        code: 'upstream_timeout',
        message: `task ${row.id} hold expired before completion (§7.3 backstop)`,
        retryable: false,
        failover: false,
      },
      task: row,
    });
    if (r.failed) failed += 1;
  }
  return { scanned: rows.length, failed };
}
