// packages/engine/src/gateway/settle-task.ts
//
// model-supply-greenfield 批次4 slice2 — the §9.2 GATEWAY SETTLE (双卡叠加)
// and its no-charge failure twin:
//
//   settleGatewayResult — 成本卡 ‖ 售价卡 → 倍率组 → 租户折扣 (sale side charge,
//     REUSING the domain primitives via the engine's settledCost — hold-capped,
//     单一取整), cost side computed INDEPENDENTLY for reconciliation (两侧独立
//     可对账, never affects the charge), price snapshots (card id + version)
//     stamped on the task row AND the ledger, `estimated` marked whenever usage
//     was not upstream-reported. 转存先于 succeeded (§7.5): the persist hook
//     runs BEFORE the settle transaction; a required-persist failure takes the
//     fail path (no charge) instead.
//
//   failGatewayResult — terminal transition + hold release, ZERO charge. THE
//     §3 at-most-once money path: a `direct` task that dies (submit failure,
//     crash takeover) is failed and NEVER charged — the upstream cost is
//     platform-absorbed, and re-submission is forbidden at this layer by
//     construction (there is no retry surface here at all).
//
// The transactional writes live in @actionow/db (settleGatewayTask /
// failGatewayTask — the settleJob 范式 over `task`); this module owns the
// AMOUNTS and the composition.
import type {
  ArtifactMode,
  BillingDims,
  GatewayError,
  GatewayUsage,
  GatewayWarning,
  Modifier,
  PricebookEntry,
  PriceCardSnapshotRef,
  PriceSpec,
} from '@actionow/contracts';
import { PRICE_METHODS } from '@actionow/contracts';
import type { DbOrTx, SupplyPriceCardRow, TaskRow } from '@actionow/db';
import {
  failGatewayTask,
  getSupplyPriceCardsByIdsIncludingDeleted,
  settleGatewayTask,
  transitionTask,
} from '@actionow/db';
import { DomainError, type MicroCredits } from '@actionow/domain';

import type { HoldWallet, PriceCardRef, Reservation } from '../planner/index.js';
import { computeFinalCost, serializeAppliedModifiers, settledCost } from '../pricing.js';
import type { TaskWebhookEmitter, TaskWebhookEventType } from './task-webhook.js';
import { emitTaskWebhookBestEffort } from './task-webhook.js';

// --- deps -----------------------------------------------------------------------

/** The db write/read surface (injectable; production omits → real @actionow/db repos). */
export interface GatewaySettleRepo {
  settleGatewayTask: typeof settleGatewayTask;
  failGatewayTask: typeof failGatewayTask;
  transitionTask: typeof transitionTask;
  /**
   * §2.7 snapshot re-fetch — MUST include soft-deleted rows: a card deleted
   * between hold and settle still re-prices exactly (card rows are immutable;
   * soft delete only closes NEW admissions). Wiring the live-filtered variant
   * here would silently charge the hold ceiling — 钱账红线.
   */
  getSupplyPriceCardsByIdsIncludingDeleted: typeof getSupplyPriceCardsByIdsIncludingDeleted;
}

export interface GatewaySettleDeps {
  db: DbOrTx;
  repo?: Partial<GatewaySettleRepo> | undefined;
  /**
   * §7.6 downstream-webhook emitter (slice4): settle/fail are THE terminal
   * funnels for every gateway task (dispatch, worker recovery, callbacks,
   * reapers all flow through them), so terminal event envelopes are enqueued
   * HERE — best-effort, AFTER the money transaction, never able to fail it.
   * Absent → the production emitter; tests inject recorders. Tasks without a
   * `callback_url` short-circuit before any write.
   */
  emitTaskWebhook?: TaskWebhookEmitter | undefined;
  /**
   * §7.5 降级告警 (slice5): fired when persistence fails WITHOUT
   * `requirePersist` and the settle degrades to the upstream URL. Best-effort
   * observability only — never in the money path. Default `console.warn`.
   */
  alert?: ((message: string, context?: Record<string, unknown>) => void) | undefined;
}

/** Enqueue a terminal §7.6 event — best-effort, post-transaction (不入钱路). */
async function emitTerminalWebhook(
  deps: GatewaySettleDeps,
  task: TaskRow | undefined,
  eventType: TaskWebhookEventType,
): Promise<void> {
  await emitTaskWebhookBestEffort({ db: deps.db, emit: deps.emitTaskWebhook }, task, eventType);
}

function repoOf(deps: GatewaySettleDeps): GatewaySettleRepo {
  return {
    settleGatewayTask: deps.repo?.settleGatewayTask ?? settleGatewayTask,
    failGatewayTask: deps.repo?.failGatewayTask ?? failGatewayTask,
    transitionTask: deps.repo?.transitionTask ?? transitionTask,
    getSupplyPriceCardsByIdsIncludingDeleted:
      deps.repo?.getSupplyPriceCardsByIdsIncludingDeleted ??
      getSupplyPriceCardsByIdsIncludingDeleted,
  };
}

// --- persist hook (§7.5 转存先于 succeeded — slice2 wired the seam, slice5 fills it) ---

/** One persisted storage object — the §9.4 checksum + lifecycle record unit. */
export interface PersistedArtifactObject {
  key: string;
  /** Hex sha256 of the stored bytes (§9.4 public 轨保留 checksum; recorded for both tracks). */
  sha256: string;
  bytes: number;
  contentType?: string | undefined;
}

/** The §9.4 双轨 result a successful persist reports alongside the rewritten output. */
export interface PersistArtifactRecord {
  mode: ArtifactMode;
  /** signed 轨: settle + retention (reaper 到期标记 expired); public 轨: null (豁免清理). */
  expiresAt: Date | null;
  objects: PersistedArtifactObject[];
  /** Non-fatal notices (e.g. public denied by tenant policy → degraded to signed). */
  warnings?: GatewayWarning[] | undefined;
}

export type PersistOutcome =
  | { ok: true; output?: unknown; artifact?: PersistArtifactRecord | undefined }
  | { ok: false; error: GatewayError };

/**
 * The §9.4 artifact-track hint the request path resolved (request override —
 * validated against tenant policy INSIDE the hook — else model default), plus
 * the model's declared signed-track retention. All optional: the worker
 * recovery path reconstructs from the task row alone and the hook falls back
 * (row stamp → model lookup → platform default → signed).
 */
export interface PersistArtifactHint {
  mode?: ArtifactMode | null | undefined;
  retentionDays?: number | null | undefined;
}

/**
 * The §7.5 artifact-persistence hook: invoked BEFORE the settle transaction so
 * 转存 strictly precedes `succeeded`. `{ok: true, output}` may substitute the
 * delivered output (e.g. platform URLs replacing upstream URLs) and reports
 * the resolved §9.4 artifact record for the settle transaction to stamp;
 * `{ok: false}` under `requirePersist` ⇒ the task FAILS and nothing is charged
 * (§7.5 失败即 fail 不扣费); without `requirePersist` the settle proceeds on
 * the original output with a degradation warning + 告警 (§7.5 降级交付).
 * `tenantId`/`artifact` are OPTIONAL additive context (slice5) — a hook that
 * only reads output/usage/task keeps working unchanged.
 */
export type PersistHook = (input: {
  output: unknown;
  usage: GatewayUsage;
  task?: TaskRow | undefined;
  tenantId?: string | undefined;
  artifact?: PersistArtifactHint | undefined;
}) => Promise<PersistOutcome>;

// --- synthetic price-card entry (the computeGateHold port, §9.2) -------------------

/** Methods whose price is ALWAYS fully known from request params (quote-timed). */
const ALWAYS_PRE_METHODS: ReadonlySet<string> = new Set(['fixed', 'matrix', 'formula']);

/**
 * §9.2/§4 rule 2 — can this card be quoted purely from the effective value
 * vector? Same judgment as the gate's hold timing (gate.ts
 * `preQuotableFromDims`, kept in sync by the settle-vs-hold parity tests):
 * fixed/matrix/formula always; credits/model_token when the vector carries
 * every priced dimension; unit/passthrough never.
 */
function preQuotable(spec: PriceSpec, dims: Record<string, unknown>): boolean {
  if (ALWAYS_PRE_METHODS.has(spec.method)) return true;
  if (spec.method === 'credits') {
    return Object.keys(spec.dimensions).every((d) => dims[d] !== undefined);
  }
  if (spec.method === 'model_token') {
    return dims.input_tokens !== undefined && dims.output_tokens !== undefined;
  }
  return false;
}

/**
 * Wrap a §2.7 price card as a synthetic {@link PricebookEntry} so the REUSED
 * domain pricing primitives (quote/settle via the engine's settledCost /
 * computeFinalCost) price it without a second implementation — the same
 * re-basing the §7.8 gate does for the hold.
 */
export function priceCardEntry(
  card: Pick<SupplyPriceCardRow, 'id' | 'version' | 'spec'>,
  dims: Record<string, unknown>,
): PricebookEntry {
  const spec = card.spec;
  if (!(PRICE_METHODS as readonly string[]).includes(spec.method)) {
    throw new DomainError('invalid_pricing', `unknown price method '${spec.method}'`);
  }
  return {
    resourceId: `price_card:${card.id}`,
    resourceVersion: 0,
    version: card.version,
    method: spec.method,
    timing: preQuotable(spec, dims) ? 'pre' : 'post',
    spec,
  };
}

// --- 双卡 settle computation (§9.2 叠加顺序, pure) ----------------------------------

export interface DualSettleInput {
  /** The model's SALE card row (the charge side). */
  saleCard: Pick<SupplyPriceCardRow, 'id' | 'version' | 'spec'>;
  /** The offering's COST card row; null = cost not declared (reconciliation degraded, §2.7). */
  costCard: Pick<SupplyPriceCardRow, 'id' | 'version' | 'spec'> | null;
  /** billing_relevant effective CANONICAL values — the sale tier key (§4 rule 2). */
  billingDims: BillingDims;
  /** EffectiveParams.upstream — the cost side prices on the offering's ACTUAL values (§4 rule 2 双向可见). */
  upstreamInputs: Record<string, unknown>;
  /** The observed usage (SPI aspect ⑤ extraction). */
  usage: GatewayUsage;
  /** The resolved SALE-side modifier stack (§9.2 倍率组 → 租户折扣) — never applied to cost. */
  modifiers: Modifier[];
  /** The §7.8 hold — the charge ceiling (封顶). */
  holdAmount: MicroCredits;
}

export interface DualSettleResult {
  /** The sale-side charge: 双卡→倍率→折扣, hold-capped (§9.2 封顶). */
  finalCost: MicroCredits;
  /** JSON-safe applied-modifier audit rows. */
  applied: ReturnType<typeof serializeAppliedModifiers>;
  /** Cost-side µ-credits (reconciliation only, NO modifiers, NOT capped); null = no cost card / compute failed. */
  costSide: MicroCredits | null;
  /** §9.2 estimated 标志: usage platform-estimated or absent entirely. */
  estimated: boolean;
}

/**
 * §9.2 叠加顺序 fixed: 供给项成本卡（成本侧）‖ 模型售价卡 → 倍率组 → 租户折扣
 * （售价侧）. The sale side REUSES the engine's proven `settledCost` (hold cap +
 * no-usage-charges-hold + single rounding); the cost side is computed
 * independently for reconciliation and NEVER touches the charge — a cost-card
 * computation failure degrades to `costSide: null` (对账降级), it must not fail
 * a billable settle.
 */
export function computeDualSettle(input: DualSettleInput): DualSettleResult {
  const estimated = input.usage.estimated || Object.keys(input.usage.metrics).length === 0;

  const saleEntry = priceCardEntry(input.saleCard, input.billingDims);
  const { credits: finalCost, applied } = settledCost(
    saleEntry,
    input.usage.metrics,
    input.billingDims,
    input.modifiers,
    input.holdAmount,
  );

  let costSide: MicroCredits | null = null;
  if (input.costCard !== null) {
    try {
      const costEntry = priceCardEntry(input.costCard, input.upstreamInputs);
      costSide = computeFinalCost(costEntry, input.usage.metrics, input.upstreamInputs, []).credits;
    } catch {
      costSide = null; // cost side is audit-only — degraded, never fatal (§9.2 对账降级)
    }
  }

  return { finalCost, applied: serializeAppliedModifiers(applied), costSide, estimated };
}

// --- settleGatewayResult ------------------------------------------------------------

/** Convert the planner's camelCase card ref to the frozen snapshot shape (§9.2). */
export function snapshotRef(ref: PriceCardRef | null): PriceCardSnapshotRef | null {
  return ref === null ? null : { card_id: ref.cardId, version: ref.version };
}

export interface SettleGatewayResultInput {
  tenantId: string;
  /** The tenant pool account (ledger attribution — required even when a sub-wallet moves). */
  accountId: string;
  subjectId?: string | null | undefined;
  /**
   * 批次6 P5b — the EXTERNAL model name (request.model / the row's inputs
   * snapshot). Present ⇒ the settle transaction mirrors this call into
   * `usage_log` (provider_cost = the §9.2 cost side) and accrues its
   * spend/tokens into `limit_usage` (§9.1 层2 闭环). Absent ⇒ no usage row —
   * the old relay's `usageLogModel === undefined` gating, verbatim.
   */
  model?: string | undefined;
  /** The calling api_key (key-plan accrual scope); null/absent → keyless. */
  apiKeyId?: string | null | undefined;
  /** The per-request route tag (染色 echo into usage_log); null/absent → untagged. */
  routeTag?: string | null | undefined;
  /** Where the §7.8 hold landed (reservation.holdTxn.wallet, or reconstructed from task columns). */
  wallet: HoldWallet;
  holdAmount: MicroCredits;
  saleCardRef: PriceCardRef;
  costCardRef: PriceCardRef | null;
  billingDims: BillingDims;
  /** EffectiveParams.upstream (cost-side inputs); absent → {}. */
  upstreamInputs?: Record<string, unknown> | undefined;
  /** The resolved sale-side modifier stack (§9.2). */
  modifiers: Modifier[];
  usage: GatewayUsage;
  output: unknown;
  /** The task row to move → succeeded; absent ⇒ sync path (wallet + ledger only). */
  task?: TaskRow | undefined;
  /**
   * The live §7.8 reservation (in-request paths). On SUCCESS its SLOT alone is
   * released (hold 转 settle — the wallet moves inside the settle tx, so
   * `reservation.release()` must NOT run); on a required-persist failure the
   * full fail path runs (transition + release()).
   */
  reservation?: Reservation | undefined;
  /** Ledger attribution (`supply_offering:<id>`). */
  offeringId: string;
  /** §7.5 hooks. */
  persist?: PersistHook | undefined;
  requirePersist?: boolean | undefined;
  /** §9.4 artifact-track hint threaded into the persist hook (request/model resolution). */
  artifact?: PersistArtifactHint | undefined;
}

export type SettleGatewayOutcome =
  | {
      ok: true;
      finalCost: MicroCredits;
      estimated: boolean;
      /** false = the task was already terminal (idempotent replay — nothing moved). */
      settled: boolean;
      task?: TaskRow | undefined;
      /** The SETTLED output (§7.5 转存 URL 替换 applied) — deliver THIS, not the raw. */
      output?: unknown;
      /** §7.5 degradation / §9.4 policy notices to merge into the response warnings[]. */
      warnings?: GatewayWarning[] | undefined;
    }
  | { ok: false; error: GatewayError };

/** Best-effort SLOT-only release (the §7.8 semaphore half; a leaked slot self-heals via TTL). */
async function releaseSlotBestEffort(reservation: Reservation): Promise<void> {
  try {
    await reservation.slot.release();
  } catch {
    // Swallowed by design — a semaphore DECR failure must never mask a settled charge.
  }
}

/**
 * THE gateway settle (§9.2). Order:
 *
 * 1. §7.5 persist hook (转存先于 succeeded). Failure + requirePersist ⇒ fail
 *    path (no charge) and `{ok: false}`; failure without ⇒ degrade, continue.
 * 2. Re-fetch the snapshot cards INCLUDING soft-deleted rows (§2.7 快照
 *    {card_id, version} 软删后仍精确重建 — each card VERSION is its own
 *    immutable row, so the id-fetch IS the version fetch, and a soft delete
 *    between hold and settle must not change the price). Only a sale card id
 *    that NEVER existed (hard drift) charges the hold ceiling (the price known
 *    at admission) rather than serving free.
 * 3. 双卡 computation ({@link computeDualSettle}) — 封顶 holdAmount.
 * 4. ONE transaction (db settleGatewayTask): task → succeeded + wallet
 *    (release hold, debit final) + ledger row with the §9.2 price snapshot.
 * 5. Release the reservation's SLOT (never its hold — that just settled).
 */
export async function settleGatewayResult(
  deps: GatewaySettleDeps,
  input: SettleGatewayResultInput,
): Promise<SettleGatewayOutcome> {
  const repo = repoOf(deps);

  // 1. 转存先于 succeeded (§7.5).
  let output = input.output;
  let artifact: PersistArtifactRecord | undefined;
  const warnings: GatewayWarning[] = [];
  if (input.persist !== undefined) {
    const persisted = await input.persist({
      output,
      usage: input.usage,
      task: input.task,
      tenantId: input.tenantId,
      artifact: input.artifact,
    });
    if (!persisted.ok) {
      if (input.requirePersist === true) {
        await failGatewayResult(deps, {
          error: persisted.error,
          task: input.task,
          reservation: input.reservation,
        });
        return { ok: false, error: persisted.error };
      }
      // §7.5 降级交付: settle on the ORIGINAL upstream output, echo the
      // degradation in warnings[] and fire the best-effort 告警. The artifact
      // columns are left untouched (nothing durable was written; the row keeps
      // its create-time stamp and — expiry-less — is reaper-exempt).
      warnings.push({
        code: 'artifact_persist_degraded',
        message: `artifact persistence failed — delivering the upstream URL (§7.5 降级): ${persisted.error.message}`,
      });
      (deps.alert ?? console.warn)(
        `§7.5 artifact persistence degraded${input.task !== undefined ? ` for task ${input.task.id}` : ''}: ${persisted.error.message}`,
        { taskId: input.task?.id, tenantId: input.tenantId, error: persisted.error },
      );
    } else {
      if (persisted.output !== undefined) output = persisted.output;
      artifact = persisted.artifact;
      if (persisted.artifact?.warnings !== undefined) warnings.push(...persisted.artifact.warnings);
    }
  }

  // 2. price snapshot rows — soft-deleted cards INCLUDED (§2.7): the snapshot
  //    ref pins {cardId, version} against immutable rows, so a hold↔settle
  //    soft delete still reconstructs the exact quoted price.
  const cardIds = [input.saleCardRef.cardId];
  if (input.costCardRef !== null) cardIds.push(input.costCardRef.cardId);
  const cards = await repo.getSupplyPriceCardsByIdsIncludingDeleted(deps.db, cardIds);
  const saleCard = cards.get(input.saleCardRef.cardId);
  const costCard =
    input.costCardRef !== null ? (cards.get(input.costCardRef.cardId) ?? null) : null;

  // 3. 双卡 computation. Only a sale card id that NEVER existed (hard drift —
  //    a soft delete no longer hides it) cannot re-price — charge the hold
  //    ceiling (the modifier-adjusted price quoted at admission), never 0.
  const dual: DualSettleResult =
    saleCard !== undefined
      ? computeDualSettle({
          saleCard,
          costCard,
          billingDims: input.billingDims,
          upstreamInputs: input.upstreamInputs ?? {},
          usage: input.usage,
          modifiers: input.modifiers,
          holdAmount: input.holdAmount,
        })
      : {
          finalCost: input.holdAmount,
          applied: [],
          costSide: null,
          estimated: true,
        };

  // 4. the settle transaction (§9.2 快照 into task columns + ledger envelope).
  const modifiersApplied = {
    applied: dual.applied,
    sale_card_ref: snapshotRef(input.saleCardRef),
    cost_card_ref: snapshotRef(input.costCardRef),
    cost_side_credits: dual.costSide?.toString() ?? null,
    estimated: dual.estimated,
    ...(saleCard === undefined ? { sale_card_missing: true } : {}),
  };
  const usage: GatewayUsage = { ...input.usage, estimated: dual.estimated };
  const settled = await repo.settleGatewayTask(deps.db, {
    taskId: input.task?.id ?? null,
    tenantId: input.tenantId,
    accountId: input.accountId,
    subjectId: input.subjectId ?? null,
    subAccountId: input.wallet.kind === 'subject' ? input.wallet.subAccountId : null,
    holdAmount: input.holdAmount,
    finalCost: dual.finalCost,
    usage,
    output,
    estimated: dual.estimated,
    saleCardRef: snapshotRef(input.saleCardRef),
    costCardRef: snapshotRef(input.costCardRef),
    modifiersApplied,
    resourceId: `supply_offering:${input.offeringId}`,
    // §9.4: the RESOLVED artifact track lands atomically with succeeded —
    // signed rows get their expiry (the reaper's feed), public rows a NULL
    // expiry (豁免清理) with the checksum objects on the settle event.
    ...(artifact !== undefined
      ? {
          artifactMode: artifact.mode,
          artifactExpiresAt: artifact.expiresAt,
          artifactObjects: artifact.objects,
        }
      : {}),
    // 批次6 P5b — usage_log mirror + spend/tokens limit accrual (§9.1 层2),
    // written INSIDE the same guarded settle transaction. provider_cost = the
    // §9.2 cost side (对账/margin analytics; null = degraded). Gated on the
    // model attribution being known — every production caller (execute's
    // buildSettleBase, recovery's reconstructSettleBase) supplies it.
    ...(input.model !== undefined
      ? {
          usageLog: {
            model: input.model,
            apiKeyId: input.apiKeyId ?? null,
            providerCost: dual.costSide,
            routeTag: input.routeTag ?? null,
          },
        }
      : {}),
  });

  // 5. hold 转 settle → only the semaphore half of the reservation releases.
  if (input.reservation !== undefined) await releaseSlotBestEffort(input.reservation);

  // 6. §7.6 terminal event — ONLY the writer that actually moved the row emits
  //    (settled: false = idempotent replay ⇒ the earlier writer already did),
  //    so callback-vs-poll double writes deliver exactly one envelope.
  if (settled.settled) await emitTerminalWebhook(deps, settled.task, 'task.succeeded');

  return {
    ok: true,
    finalCost: dual.finalCost,
    estimated: dual.estimated,
    settled: settled.settled,
    task: settled.task,
    output,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// --- failGatewayResult ----------------------------------------------------------------

export interface FailGatewayResultInput {
  error: GatewayError;
  task?: TaskRow | undefined;
  /**
   * The live reservation (in-request paths): `release()` frees BOTH semaphore
   * dimensions and rolls the hold back (idempotent — the §7.8 contract).
   */
  reservation?: Reservation | undefined;
  to?: 'failed' | 'canceled' | undefined;
}

/**
 * Fail a gateway execution WITHOUT charging. Two shapes:
 *
 * - With a live reservation (sync/stream/task submit failures): transition the
 *   task (when one exists) → failed, then `reservation.release()` — the §7.8
 *   失败即释放信号量并回滚 hold contract, and the §3 at-most-once money rule
 *   (direct 崩溃/失败 ⇒ 不扣费, platform absorbs). When the transition NO-OPS
 *   (the row was already terminalized by another writer, e.g. the slice4 hold
 *   reaper) the release is SKIPPED — the terminalizing writer already disposed
 *   of the hold, and releasing again would double-free `credit_held`.
 * - Without one (slice4 worker / crash recovery): the db `failGatewayTask`
 *   transaction releases the hold from the task's OWN wallet columns.
 */
export async function failGatewayResult(
  deps: GatewaySettleDeps,
  input: FailGatewayResultInput,
): Promise<{ failed: boolean; task?: TaskRow | undefined }> {
  const repo = repoOf(deps);
  const to = input.to ?? 'failed';
  const eventType: TaskWebhookEventType = to === 'canceled' ? 'task.canceled' : 'task.failed';

  if (input.reservation !== undefined) {
    if (input.task !== undefined) {
      const task = await repo.transitionTask(deps.db, input.task.id, ['pending', 'running'], to, {
        error: input.error,
        finishedAt: new Date(),
        eventPayload: input.error,
      });
      if (task === undefined) {
        // The row was ALREADY terminalized by another writer (slice4 hold
        // reaper / late callback / racing settle): THAT writer disposed of the
        // hold (row-column release or settle), so releasing the reservation
        // here would credit `credit_held` a SECOND time (潜伏双放) — the
        // mirror of the settle side's `settled: false` zero-movement guard.
        // The in-process slot is left to its safety-TTL self-heal (a leaked
        // slot is recoverable; a double wallet credit is not).
        return { failed: false };
      }
      await input.reservation.release();
      await emitTerminalWebhook(deps, task, eventType); // §7.6 — winner emits
      return { failed: true, task };
    }
    await input.reservation.release();
    return { failed: true };
  }

  if (input.task !== undefined) {
    const r = await repo.failGatewayTask(deps.db, {
      taskId: input.task.id,
      tenantId: input.task.tenantId,
      accountId: input.task.accountId,
      subAccountId: input.task.subAccountId,
      holdAmount: input.task.holdAmount ?? 0n,
      to,
      error: input.error,
    });
    // §7.6: only the writer that MOVED the row emits (settled: false = another
    // writer already terminalized and emitted).
    if (r.settled) await emitTerminalWebhook(deps, r.task ?? input.task, eventType);
    return { failed: r.settled, ...(r.task !== undefined ? { task: r.task } : {}) };
  }

  return { failed: false };
}
