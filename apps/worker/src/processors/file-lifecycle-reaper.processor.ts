import {
  listLiveFilesOlderThanForTenant,
  listTenantsWithFileTtl,
  markFileObjectsDeleted,
} from '@actionow/db';

import type { WorkerRuntime } from '../runtime.js';

const MS_PER_DAY = 86_400_000;
/** Soft-delete + bucket-delete in bounded batches so the first sweep never holds one big lock. */
const MAX_BATCH = 500;
/** Per-tenant safety cap per sweep so a huge backlog drains over several ticks, not one. */
const MAX_FILES_PER_SWEEP = 5000;

/**
 * Build the `file-lifecycle-reaper` processor (opt-in per-tenant file TTL). For
 * every tenant with a STRICTLY POSITIVE effective retention window — its own
 * `account.config.file_ttl_days` override, else the platform-wide
 * `FILE_RETENTION_DAYS` default — soft-delete (tombstone) `file_object` rows
 * older than that window and best-effort remove the bucket object. A tenant with
 * NO override and NO platform default is skipped entirely (files retained
 * forever), and when no tenant is eligible the sweep is a no-op returning 0.
 *
 * DATA-LOSS CRITICAL: the eligibility predicate ({@link listTenantsWithFileTtl})
 * is the single guard that 0/absent/null TTL is never swept — apps own their data
 * and hold `file_id`s as references, so auto-delete is opt-in only.
 *
 * The bucket delete is best-effort/idempotent (errors swallowed; the soft-delete
 * tombstone is the system of record — an orphaned object is swept again or aged
 * out by bucket lifecycle). Pure over the injected runtime for unit testing.
 */
export function createFileLifecycleReaperProcessor(runtime: WorkerRuntime): () => Promise<number> {
  return async (): Promise<number> => {
    const platformDefault = runtime.env.FILE_RETENTION_DAYS;
    const tenants = await listTenantsWithFileTtl(runtime.db, platformDefault);
    if (tenants.length === 0) return 0;

    let totalSwept = 0;
    for (const { tenantId, ttlDays } of tenants) {
      const cutoff = new Date(Date.now() - ttlDays * MS_PER_DAY);
      let sweptForTenant = 0;
      for (;;) {
        const remaining = MAX_FILES_PER_SWEEP - sweptForTenant;
        if (remaining <= 0) break;
        const limit = Math.min(MAX_BATCH, remaining);
        const files = await listLiveFilesOlderThanForTenant(runtime.db, tenantId, cutoff, limit);
        if (files.length === 0) break;

        // Best-effort physical removal first; never let a bucket error abort the
        // batch (the tombstone below is the system of record).
        if (runtime.storage !== null) {
          for (const file of files) {
            try {
              await runtime.storage.delete(file.key);
            } catch {
              // swallow: orphaned object is non-fatal; the row still tombstones.
            }
          }
        }

        const deleted = await markFileObjectsDeleted(
          runtime.db,
          files.map((f) => f.id),
        );
        sweptForTenant += deleted;
        totalSwept += deleted;

        if (files.length < limit) break;
      }
    }

    console.log(
      `file-lifecycle-reaper: scanned ${String(tenants.length)} tenant(s), swept ${String(totalSwept)} file(s)`,
    );
    return totalSwept;
  };
}
