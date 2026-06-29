import { deleteRelayTracesOlderThan } from '@actionow/db';

import type { WorkerRuntime } from '../runtime.js';

const MS_PER_DAY = 86_400_000;

/**
 * Build the `relay-trace-reaper` processor: when `RELAY_TRACE_RETENTION_DAYS` is
 * set (admin override 动态配置 → env default), hard-delete `relay_trace` rows older
 * than that window so the unbounded debug-trace table can't fill Postgres; unset
 * → a no-op (returns 0). Scheduled
 * as a repeatable BullMQ sweep. Returns the count pruned. Pure over the injected
 * runtime for unit testing.
 */
export function createRelayTraceReaperProcessor(runtime: WorkerRuntime): () => Promise<number> {
  return async (): Promise<number> => {
    // Dynamic-config (动态配置): an admin override takes precedence over the env
    // default; the resolver is fail-open, so a settings outage falls back to env.
    const days =
      (await runtime.settings?.get('RELAY_TRACE_RETENTION_DAYS')) ??
      runtime.env.RELAY_TRACE_RETENTION_DAYS;
    if (days === undefined) return 0;
    const cutoff = new Date(Date.now() - days * MS_PER_DAY);
    return deleteRelayTracesOlderThan(runtime.db, cutoff);
  };
}
