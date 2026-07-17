// apps/worker/src/processors/artifact-reaper.processor.ts
//
// model-supply-greenfield 批次4 slice5 — the §9.4 signed-track artifact
// lifecycle sweep (the file-lifecycle-reaper 范式, task-column driven):
//
//   signed 轨: succeeded tasks whose `artifact_expires_at` lapsed are marked
//   artifact-expired (internal_substate + a task_events lifecycle record).
//   The task's EXTERNAL terminal status stays `succeeded` — §7.1 终态禁迁移
//   holds (择稳裁决: artifact expiry is a PRODUCT-lifecycle marker; the
//   external Task view already exposes `expires_at` for clients to judge).
//
//   public 轨: EXEMPT by construction (§9.4 可豁免清理) — the repo feed
//   filters artifact_mode='signed', so public rows are never swept while their
//   sha256 checksums + lifecycle objects stay on the settle event/output.
//
// Physical bucket deletion is deliberately NOT performed here (the durable
// mark is the system of record; byte cleanup is bucket-lifecycle / a later
// slice — mirrors the file-lifecycle-reaper's tombstone-first discipline).
import { listExpiredSignedArtifactTasks, markTaskArtifactExpired } from '@actionow/db';

import type { WorkerRuntime } from '../runtime.js';

/** Rows pulled per batch. */
const MAX_BATCH = 100;
/** Safety cap per sweep so a huge backlog drains over several ticks, not one. */
const MAX_TASKS_PER_SWEEP = 2000;

/** Build the `artifact-reaper` processor (repeatable BullMQ sweep, hourly). */
export function createArtifactReaperProcessor(runtime: WorkerRuntime): () => Promise<number> {
  return async (): Promise<number> => {
    const now = new Date();
    let total = 0;
    for (;;) {
      const remaining = MAX_TASKS_PER_SWEEP - total;
      if (remaining <= 0) break;
      const due = await listExpiredSignedArtifactTasks(
        runtime.db,
        now,
        Math.min(MAX_BATCH, remaining),
      );
      if (due.length === 0) break;
      let marked = 0;
      for (const row of due) {
        if (await markTaskArtifactExpired(runtime.db, row.id)) marked += 1;
      }
      total += marked;
      // No row moved (every candidate lost its race / drifted) → stop rather
      // than re-listing the same feed forever.
      if (marked === 0 || due.length < MAX_BATCH) break;
    }
    if (total > 0) {
      console.log(`artifact-reaper: marked ${String(total)} signed artifact(s) expired (§9.4)`);
    }
    return total;
  };
}
