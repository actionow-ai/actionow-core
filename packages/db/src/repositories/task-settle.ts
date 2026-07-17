import type {
  GatewayError,
  GatewayUsage,
  PriceCardSnapshotRef,
  TaskStatus,
} from '@actionow/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { account } from '../schema/index.js';
import { appendLedger } from './ledger.js';
import { releaseSubAccountHold, settleSubAccount } from './sub-account.js';
import { type TaskRow, transitionTask } from './task.js';
import type { DbOrTx } from './types.js';
import { insertUsageLog, usageBreakdownFields } from './usage.js';

// model-supply-greenfield 批次4 slice2 — the GATEWAY settle/fail primitives
// (§9.2), the {@link settleJob}/{@link failJob} 范式 re-based onto the NEW-WORLD
// `task` table (§7.1). Amount COMPUTATION (双卡叠加/封顶/快照 assembly) lives in
// the engine (packages/engine/src/gateway/settle-task.ts); this layer owns the
// TRANSACTION: guarded task transition + wallet movement + ledger row commit or
// roll back together.
//
// Ledger note: `ledger_txn.job_id` is an FK to the OLD-WORLD `job` table, so
// task settles write `jobId: null` and carry the task attribution in
// `resourceId` (`task:<id>` / `supply_offering:<id>`); the settle-once dedup is
// the guarded `pending|running → succeeded` transition (the settleJob
// precedent names the transition guard as the primary dedup).

/**
 * 批次6 P5b — the settle's usage_log mirror + limit accrual attribution (§9.1
 * 层2 闭环). Present ⇒ the settle transaction appends ONE `usage_log` row
 * (status `succeeded`, `cost` = finalCost, `provider_cost` = the §9.2 cost
 * side) via {@link insertUsageLog}, which itself accrues the call's
 * spend/tokens into `limit_usage` (the proven `accrueLimitUsage` primitive) —
 * so the §7.8 read-only precheck (`precheckQuota` → getUsage/windowedUsage)
 * sees NEW-FACE settles exactly like it saw the legacy guard's. Absent ⇒ no
 * usage row (the old `usageLogModel === undefined` relay gating, verbatim).
 */
export interface SettleUsageLogInput {
  /** The EXTERNAL model name (usage_log.model + model-scoped rule narrowing). */
  model: string;
  /** The calling api_key (key-plan accrual scope); null → console/keyless. */
  apiKeyId: string | null;
  /** §9.2 cost side (µUSD) → usage_log.provider_cost; null = 对账降级 (unknown). */
  providerCost: bigint | null;
  /** The per-request route tag (染色 echo); null/absent → untagged. */
  routeTag?: string | null | undefined;
}

/** One gateway settle: charge `finalCost`, release `holdAmount`, snapshot the §9.2 price refs. */
export interface SettleGatewayTaskInput {
  /** The task to move `pending|running → succeeded`; absent ⇒ sync path (no task row — wallet + ledger only). */
  taskId?: string | null | undefined;
  tenantId: string;
  /** The tenant pool account — the ledger row's attribution even when a sub-wallet moves. */
  accountId: string;
  /** Subject attribution (ledger); null → tenant-level. */
  subjectId?: string | null | undefined;
  /** When set, the hold landed on this sub-wallet (G-E HARD mode) and settles against it. */
  subAccountId?: string | null | undefined;
  /** The hold placed by the §7.8 gate; released as part of the settle. */
  holdAmount: bigint;
  /** The final charge (already 双卡-computed, modifier-applied and hold-capped by the engine). */
  finalCost: bigint;
  usage: GatewayUsage | null;
  output?: unknown;
  /** §9.2 estimated 标志 — usage was platform-estimated, not upstream-reported. */
  estimated: boolean;
  /** §9.2 price snapshots (card id + version) — stamped on the task row AND the ledger. */
  saleCardRef: PriceCardSnapshotRef | null;
  costCardRef: PriceCardSnapshotRef | null;
  /** JSON-safe modifier audit + snapshot envelope for `ledger_txn.modifiers_applied`. */
  modifiersApplied?: unknown;
  /** Ledger attribution string (e.g. `supply_offering:<id>`). */
  resourceId?: string | null | undefined;
  /**
   * §9.4 产物双轨 (批次4 slice5): the RESOLVED artifact track + signed-track
   * expiry, stamped atomically with the succeeded transition (转存先于
   * succeeded — the persist hook already ran; these are its results). Absent →
   * columns untouched (non-media settle, or a degraded persist that keeps the
   * create-time stamp).
   */
  artifactMode?: string | null | undefined;
  artifactExpiresAt?: Date | null | undefined;
  /** §9.4 lifecycle record: persisted object keys + sha256 checksums, onto the settle event. */
  artifactObjects?: unknown;
  /**
   * 批次6 P5b — usage_log mirror + spend/tokens limit accrual, INSIDE this
   * guarded transaction (§7.8: 预检只读、settle 侧累计写; the transition
   * no-op's early return above the write is the idempotency guard — a replayed
   * settle never double-accrues). Absent/null → no usage row, no accrual.
   */
  usageLog?: SettleUsageLogInput | null | undefined;
}

/** `settled: false` ⇒ the task was already terminal — no wallet movement, no ledger row (idempotent replay). */
export interface SettleGatewayTaskResult {
  settled: boolean;
  /** The post-transition task row (task path only). */
  task?: TaskRow | undefined;
  /** Post-settle balance of whichever wallet moved (present iff settled). */
  balanceAfter?: bigint | undefined;
}

/**
 * The single idempotent gateway settle (§9.2; settleJob 范式 over `task`).
 * ONE transaction:
 *
 * 1. Task path: guarded `pending|running → succeeded` transition stamping
 *    output/usage/estimated/price-snapshots (+ inline task_events row). No row
 *    moved (already terminal) → `{settled: false}` — no double charge.
 * 2. Release the hold and debit the final cost in one wallet UPDATE
 *    (sub-wallet when `subAccountId`, else the tenant pool account).
 * 3. Append the `settle` ledger row with the §9.2 price snapshot
 *    (`modifiersApplied` envelope + `pricebookVersion` = sale card version).
 */
export async function settleGatewayTask(
  db: DbOrTx,
  p: SettleGatewayTaskInput,
): Promise<SettleGatewayTaskResult> {
  return db.transaction(async (tx) => {
    let task: TaskRow | undefined;
    if (p.taskId != null) {
      task = await transitionTask(tx, p.taskId, ['pending', 'running'], 'succeeded', {
        output: p.output ?? null,
        usage: p.usage,
        estimated: p.estimated,
        saleCardRef: p.saleCardRef,
        costCardRef: p.costCardRef,
        // §9.4: stamp the RESOLVED artifact track atomically with succeeded.
        ...(p.artifactMode !== undefined ? { artifactMode: p.artifactMode } : {}),
        ...(p.artifactExpiresAt !== undefined ? { artifactExpiresAt: p.artifactExpiresAt } : {}),
        finishedAt: new Date(),
        eventPayload: {
          finalCost: p.finalCost.toString(),
          holdAmount: p.holdAmount.toString(),
          estimated: p.estimated,
          // §9.4 lifecycle record (public 轨豁免清理但保留 checksum 与生命周期记录).
          ...(p.artifactMode !== undefined ? { artifactMode: p.artifactMode } : {}),
          ...(p.artifactObjects !== undefined ? { artifactObjects: p.artifactObjects } : {}),
        },
      });
      if (task === undefined) return { settled: false };
    }

    let balanceAfter: bigint;
    if (p.subAccountId != null) {
      balanceAfter = await settleSubAccount(tx, p.subAccountId, p.holdAmount, p.finalCost);
    } else {
      const rows = await tx
        .update(account)
        .set({
          creditHeld: sql`${account.creditHeld} - ${p.holdAmount}`,
          creditBalance: sql`${account.creditBalance} - ${p.finalCost}`,
        })
        // Scope to (account, tenant) — defense-in-depth (the settleJob P2-8
        // precedent). A mismatch matches 0 rows → throw → whole settle rolls back.
        .where(and(eq(account.id, p.accountId), eq(account.tenantId, p.tenantId)))
        .returning({ balanceAfter: account.creditBalance });
      const row = rows[0];
      if (!row) throw new Error(`settleGatewayTask: account ${p.accountId} not found`);
      balanceAfter = row.balanceAfter;
    }

    await appendLedger(tx, {
      tenantId: p.tenantId,
      accountId: p.accountId,
      subjectId: p.subjectId ?? null,
      type: 'settle',
      creditsDelta: -p.finalCost,
      balanceAfter,
      // task ids are NOT job FKs (see module header) — attribution rides resourceId.
      jobId: null,
      resourceId: p.resourceId ?? (p.taskId != null ? `task:${p.taskId}` : null),
      pricebookVersion: p.saleCardRef?.version ?? null,
      modifiersApplied: p.modifiersApplied ?? null,
      usageVector: p.usage?.metrics ?? null,
    });

    // 批次6 P5b — the usage_log mirror + limit accrual, SAME guarded
    // transaction (§9.1 层2 闭环): insertUsageLog appends the per-call row
    // (rolling-window spend/tokens/requests read it via windowedUsage, margin
    // analytics read provider_cost) AND accrues spend/tokens into limit_usage
    // through the proven accrueLimitUsage primitive (+ threshold alerts). The
    // task path's transition guard already returned `{settled: false}` on a
    // replay BEFORE this line, so a late duplicate settle accrues NOTHING; a
    // failure here rolls the whole settle back (charge and accrual land
    // atomically or not at all — 账实一致 over best-effort).
    if (p.usageLog != null) {
      const metrics = p.usage?.metrics ?? {};
      await insertUsageLog(tx, {
        tenantId: p.tenantId,
        model: p.usageLog.model,
        inputTokens: metrics.input_tokens ?? 0,
        outputTokens: metrics.output_tokens ?? 0,
        // Breakdown counts (reasoning/cached/audio…) ride along when reported.
        ...usageBreakdownFields(metrics),
        cost: p.finalCost,
        ...(p.usageLog.providerCost !== null ? { providerCost: p.usageLog.providerCost } : {}),
        status: 'succeeded',
        ...(p.usageLog.apiKeyId !== null ? { apiKeyId: p.usageLog.apiKeyId } : {}),
        subjectId: p.subjectId ?? null,
        routeTag: p.usageLog.routeTag ?? null,
      });
    }

    return { settled: true, task, balanceAfter };
  });
}

/** One gateway fail/cancel: terminal transition + hold release, NO charge. */
export interface FailGatewayTaskInput {
  taskId: string;
  tenantId: string;
  /** The tenant pool account the hold sits on (task.account_id); null when the hold rode a sub-wallet. */
  accountId?: string | null | undefined;
  /** The sub-wallet the hold sits on instead (task.sub_account_id). */
  subAccountId?: string | null | undefined;
  /** The hold to release without charging (§7.8 回滚 / §3 at-most-once 不扣费). */
  holdAmount: bigint;
  to?: Extract<TaskStatus, 'failed' | 'canceled'> | undefined;
  error?: GatewayError | null | undefined;
}

/**
 * Fail or cancel a task WITHOUT charging (the failJob 范式 over `task`): guarded
 * `pending|running → failed|canceled` transition (+ inline event), then release
 * the hold from whichever wallet holds it. Already terminal → `{settled:false}`
 * (idempotent — e.g. a crash-recovery sweep racing a late callback). This is
 * the §3 at-most-once money path: a `direct` task's crash takeover ⇒ failed +
 * hold released + ZERO ledger charge (platform absorbs the upstream cost).
 */
export async function failGatewayTask(
  db: DbOrTx,
  p: FailGatewayTaskInput,
): Promise<{ settled: boolean; task?: TaskRow | undefined }> {
  return db.transaction(async (tx) => {
    const task = await transitionTask(tx, p.taskId, ['pending', 'running'], p.to ?? 'failed', {
      error: p.error ?? null,
      finishedAt: new Date(),
      eventPayload: p.error ?? undefined,
    });
    if (task === undefined) return { settled: false };

    if (p.holdAmount > 0n) {
      if (p.subAccountId != null) {
        await releaseSubAccountHold(tx, p.subAccountId, p.holdAmount);
      } else if (p.accountId != null) {
        const rows = await tx
          .update(account)
          .set({ creditHeld: sql`${account.creditHeld} - ${p.holdAmount}` })
          .where(and(eq(account.id, p.accountId), eq(account.tenantId, p.tenantId)))
          .returning({ id: account.id });
        if (!rows[0]) throw new Error(`failGatewayTask: account ${p.accountId} not found`);
      }
    }

    return { settled: true, task };
  });
}
