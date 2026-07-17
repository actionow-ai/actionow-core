// apps/worker/src/processors/task-poll.processor.ts
//
// model-supply-greenfield 批次4 slice4 — the §7.2 lease-takeover poll sweep:
// pull RECOVERABLE running tasks (submit_poll / submit_callback ONLY) whose
// lease is expired/missing, atomically claim each, and drive it to a terminal
// state via the engine's recovery poller (SPI runTaskQuery + settle/fail
// funnels; adaptive backoff; renew-before-probe with 失主立即停手). This is
// ALSO the §3 双保险 slow lane for submit_callback tasks — the callback fast
// path never replaces it. `direct` tasks are NEVER taken over here (§3 at-
// most-once; the task-reaper sweep owns their orphan arm).
//
// 批次4 slice5 — the §7.5 persist hook is LIVE on this path: a poll-observed
// `succeeded` runs 转存先于 succeeded (SSRF-guarded streaming transfer, §9.4
// 双轨) before any settle; require_persist failures fail WITHOUT charge.
import { hostname } from 'node:os';

import type { RecoverySweepSummary, TaskRecoveryDeps } from '@actionow/engine';
import { createPersistHook, sweepRecoverableTasks } from '@actionow/engine';
import { createMediaTransfer } from '@actionow/infra';
import { createBuiltinDialectRegistry } from '@actionow/spi';

import type { WorkerRuntime } from '../runtime.js';

/**
 * Build the `task-poll` processor. Pure over the injected runtime for unit
 * testing (`sweep` is injectable for the wiring test); the §6 dialect registry
 * is the builtin versioned set (same wiring as the api's gateway module).
 */
export function createTaskPollProcessor(
  runtime: WorkerRuntime,
  sweep: typeof sweepRecoverableTasks = sweepRecoverableTasks,
): () => Promise<RecoverySweepSummary> {
  const settings = runtime.settings;
  const deps: TaskRecoveryDeps = {
    db: runtime.db,
    dialectRegistry: createBuiltinDialectRegistry(),
    spiHttp: runtime.http,
    // §7.2 lease identity — which worker node drives taken-over tasks.
    ownerNode: hostname(),
    // §7.5 转存先于 succeeded on the POLL path (slice5): storage/base from the
    // runtime; the transfer defaults to infra's hardened streaming mover.
    persist: createPersistHook({
      db: runtime.db,
      storage: runtime.storage,
      publicBaseUrl: runtime.publicBaseUrl,
      transfer: runtime.mediaTransfer ?? createMediaTransfer(),
      resolveDefaultRetentionDays:
        settings !== undefined
          ? (): Promise<number | undefined> => settings.get('ARTIFACT_RETENTION_DAYS')
          : undefined,
    }),
  };
  return (): Promise<RecoverySweepSummary> => sweep(deps);
}
