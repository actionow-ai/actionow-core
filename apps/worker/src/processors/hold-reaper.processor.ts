import { Reaper } from '@actionow/engine';

import type { WorkerRuntime } from '../runtime.js';

/**
 * Build the `hold-reaper` processor: cancel orphan-hold jobs whose
 * `hold_expires_at < now` that are still in-flight, releasing each hold
 * (review #12). Scheduled as a repeatable BullMQ job (~every 30s). Returns the
 * count reaped. Pure over the injected runtime for unit testing.
 */
export function createHoldReaperProcessor(runtime: WorkerRuntime): () => Promise<number> {
  const reaper = new Reaper();
  return (): Promise<number> => reaper.reapExpiredHolds(runtime.db, new Date());
}
