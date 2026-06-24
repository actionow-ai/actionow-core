import type { InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, gte, lt } from 'drizzle-orm';

import { auditLog } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type AuditLogRow = InferSelectModel<typeof auditLog>;

/** Fields a caller supplies to {@link appendAuditLog}. */
export interface AppendAuditLogInput {
  readonly actorType: 'operator' | 'member' | 'system';
  readonly actorId?: string | null | undefined;
  readonly tenantId?: string | null | undefined;
  readonly subjectId?: string | null | undefined;
  /** Dotted verb, e.g. `tenant.topup`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null | undefined;
  /** Compact, non-secret context. NEVER credentials/plaintext. */
  readonly meta?: Record<string, unknown> | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * Append one audit record. Append-only — the row is never updated. Callers that
 * want best-effort, non-fatal auditing (the mutation must not roll back if the
 * audit write fails) should use the `AuditService.record` wrapper which swallows
 * + logs errors; this repo function itself rejects on a real DB error.
 */
export async function appendAuditLog(db: DbOrTx, input: AppendAuditLogInput): Promise<AuditLogRow> {
  const rows = await db
    .insert(auditLog)
    .values({
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      tenantId: input.tenantId ?? null,
      subjectId: input.subjectId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      requestId: input.requestId ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('appendAuditLog: insert returned no row');
  return row;
}

/** Filters for {@link listAuditLog} — all optional, AND-combined. */
export interface AuditLogFilter {
  readonly tenantId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly actorType?: string | undefined;
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

/** List audit records newest-first, keyset-paginated on `(created_at, id)`. */
export function listAuditLog(
  db: DbOrTx,
  filter: AuditLogFilter,
  page: PageParams,
): Promise<KeysetResult<AuditLogRow>> {
  const preds: SQL[] = [];
  if (filter.tenantId !== undefined) preds.push(eq(auditLog.tenantId, filter.tenantId));
  if (filter.subjectId !== undefined) preds.push(eq(auditLog.subjectId, filter.subjectId));
  if (filter.actorType !== undefined) preds.push(eq(auditLog.actorType, filter.actorType));
  if (filter.action !== undefined) preds.push(eq(auditLog.action, filter.action));
  if (filter.targetType !== undefined) preds.push(eq(auditLog.targetType, filter.targetType));
  if (filter.from !== undefined) preds.push(gte(auditLog.createdAt, filter.from));
  if (filter.to !== undefined) preds.push(lt(auditLog.createdAt, filter.to));
  return keysetPage<AuditLogRow>(db, {
    table: auditLog,
    createdAtCol: auditLog.createdAt,
    idCol: auditLog.id,
    where: preds.length > 0 ? and(...preds) : undefined,
    page,
  });
}
