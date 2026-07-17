// apps/worker/src/processors/task-events-reaper.processor.ts
//
// model-supply-greenfield 批次4 slice4 — the §9.3/§7.1 task_events retention
// sweep (retention 与 relay_trace 同策略配置, 不默认永久): hard-delete event
// rows older than TASK_EVENTS_RETENTION_DAYS (动态配置 → env → 90-day code
// default; the slice1 registry key). Batched deletes inside the repo; the
// mig 0071 trigger blocks UPDATE but deliberately permits DELETE for exactly
// this sweep. The relay-trace-reaper 范式, one table over.
import { deleteTaskEventsOlderThan } from '@actionow/db';

import type { WorkerRuntime } from '../runtime.js';

const MS_PER_DAY = 86_400_000;
/** The registry's code default (SETTINGS_REGISTRY TASK_EVENTS_RETENTION_DAYS). */
const DEFAULT_RETENTION_DAYS = 90;

/** Build the `task-events-reaper` processor (repeatable BullMQ sweep, hourly). */
export function createTaskEventsReaperProcessor(runtime: WorkerRuntime): () => Promise<number> {
  return async (): Promise<number> => {
    // Dynamic-config first (fail-open resolver), env next, code default last —
    // unlike relay_trace this key is NEVER unset (§7.1 不默认永久).
    const days =
      (await runtime.settings?.get('TASK_EVENTS_RETENTION_DAYS')) ??
      runtime.env.TASK_EVENTS_RETENTION_DAYS ??
      DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * MS_PER_DAY);
    return deleteTaskEventsOlderThan(runtime.db, cutoff);
  };
}
