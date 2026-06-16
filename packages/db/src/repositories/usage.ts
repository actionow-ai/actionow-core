import type { InferSelectModel } from 'drizzle-orm';
import { desc, eq } from 'drizzle-orm';

import { usageLog } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type UsageLogRow = InferSelectModel<typeof usageLog>;

/** Fields a caller supplies to {@link insertUsageLog}. */
export interface InsertUsageLogInput {
  readonly tenantId: string;
  readonly model: string;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  /** Final µcredit charge (mirrors the settle cost). Defaults to 0. */
  readonly cost?: bigint | undefined;
  readonly latencyMs?: number | null | undefined;
  /** `succeeded` | `failed` | `canceled`. */
  readonly status: string;
}

/** Insert one per-call `usage_log` row and return it. */
export async function insertUsageLog(db: DbOrTx, input: InsertUsageLogInput): Promise<UsageLogRow> {
  const rows = await db
    .insert(usageLog)
    .values({
      tenantId: input.tenantId,
      model: input.model,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      status: input.status,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertUsageLog: insert returned no row');
  return row;
}

/** List one tenant's call logs, newest-first, capped by `limit`. */
export async function listUsageLogsByTenant(
  db: DbOrTx,
  tenantId: string,
  limit = 50,
): Promise<UsageLogRow[]> {
  return db
    .select()
    .from(usageLog)
    .where(eq(usageLog.tenantId, tenantId))
    .orderBy(desc(usageLog.createdAt))
    .limit(limit);
}

/** List every tenant's call logs, newest-first (admin global view). */
export async function listUsageLogsGlobal(db: DbOrTx, limit = 50): Promise<UsageLogRow[]> {
  return db.select().from(usageLog).orderBy(desc(usageLog.createdAt)).limit(limit);
}
