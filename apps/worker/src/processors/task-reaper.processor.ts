// apps/worker/src/processors/task-reaper.processor.ts
//
// model-supply-greenfield 批次4 slice4 — the task-center orphan/expiry sweep:
//
//   1. §3 direct orphans (slice2 handoff): running ∩ fetch=direct ∩ hold
//      expired → failed WITHOUT charge (at-most-once — no lease, no takeover,
//      NEVER re-submitted; the platform absorbs the upstream cost).
//   2. §7.3 hold-expiry backstop for every OTHER live gateway task (pending
//      rows whose dispatcher crashed, submit_poll/callback rows nobody took
//      over past budget) → failed(upstream_timeout), hold released, no charge.
//
// Both arms flow through failGatewayResult, whose from-guard makes racing
// writers converge on exactly one terminal write (and one §7.6 envelope).
import { hostname } from 'node:os';

import type { ReapSummary, TaskRecoveryDeps } from '@actionow/engine';
import { reapExpiredHoldGatewayTasks, reapOrphanedDirectTasks } from '@actionow/engine';
import { createBuiltinDialectRegistry } from '@actionow/spi';

import type { WorkerRuntime } from '../runtime.js';

export interface TaskReapReport {
  directOrphans: ReapSummary;
  expiredHolds: ReapSummary;
}

/** Build the `task-reaper` processor (repeatable BullMQ sweep, ~every 30s). */
export function createTaskReaperProcessor(runtime: WorkerRuntime): () => Promise<TaskReapReport> {
  const deps: TaskRecoveryDeps = {
    db: runtime.db,
    dialectRegistry: createBuiltinDialectRegistry(),
    spiHttp: runtime.http,
    ownerNode: hostname(),
  };
  return async (): Promise<TaskReapReport> => {
    const now = new Date();
    const directOrphans = await reapOrphanedDirectTasks(deps, now);
    const expiredHolds = await reapExpiredHoldGatewayTasks(deps, now);
    return { directOrphans, expiredHolds };
  };
}
