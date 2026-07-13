import type { DailyReconcileResult } from '@actionow/engine';
import { reconcileDaily } from '@actionow/engine';

import type { WorkerRuntime } from '../runtime.js';

const MS_PER_DAY = 86_400_000;

/**
 * Build the `reconcile-daily` processor (model-supply 批次5 slice4 — §9.2
 * 官方渠道日对账比对器): each sweep reconciles the PREVIOUS complete UTC day
 * (an in-progress day would under-count and false-alert). The threshold rides
 * the engine deps (`runtime.settings` → RECONCILIATION_DEVIATION_PCT, admin
 * override → env → default 5); deviations alert through structured
 * `console.warn` JSON context (the §7.5 降级告警 pattern). Read-only — 中转
 * channels stay monthly-report scope inside the comparer (marked, never
 * day-compared). Returns the result for BullMQ job inspection; scheduled as a
 * repeatable daily sweep (the relay-trace-reaper 范式).
 */
export function createReconcileDailyProcessor(
  runtime: WorkerRuntime,
  now: () => number = Date.now,
): () => Promise<DailyReconcileResult> {
  return async (): Promise<DailyReconcileResult> => {
    const date = new Date(now() - MS_PER_DAY).toISOString().slice(0, 10);
    const result = await reconcileDaily({ db: runtime.db, settings: runtime.settings }, { date });
    console.log(
      `reconcile-daily ${date}: official=${String(result.officialCount)} relay=${String(result.relayCount)} ` +
        `unknown=${String(result.unknownCount)} alerts=${String(result.alertsCount)} (threshold ${String(result.thresholdPct)}%)`,
    );
    return result;
  };
}
