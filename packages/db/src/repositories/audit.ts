import type { InferSelectModel, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { account, auditLog, ledgerTxn } from '../schema/index.js';
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

/**
 * The newest `audit_log` row per target id (前端打磨 — audit/version badges).
 * Feeds the entity-list badge ("last changed {when} by {who}") via the batch
 * endpoint `POST /admin/audit-log/latest`.
 */
export interface LatestAuditRow {
  readonly targetId: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly createdAt: Date;
}

/**
 * The newest `audit_log` row per `target_id` for the given `target_type`, across
 * the supplied ids. `DISTINCT ON (target_id)` keeps the first row per target in
 * the `ORDER BY` — newest `created_at` first, with `id DESC` as a deterministic
 * tiebreak when two rows share a timestamp. Ids with no audit rows are simply
 * absent from the result (the badge renders nothing for them).
 */
export async function latestAuditByTarget(
  db: DbOrTx,
  targetType: string,
  ids: string[],
): Promise<LatestAuditRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .selectDistinctOn([auditLog.targetId], {
      targetId: auditLog.targetId,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, targetType), inArray(auditLog.targetId, ids)))
    .orderBy(asc(auditLog.targetId), desc(auditLog.createdAt), desc(auditLog.id));
  // `target_id` is nullable in the schema but the WHERE pins it to the non-null
  // ids[], so every returned row has a concrete target id.
  return rows.map((r) => ({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- WHERE pins target_id non-null
    targetId: r.targetId!,
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    createdAt: r.createdAt,
  }));
}

/** One account's stored balance vs the sum of its ledger deltas (记录系统 reconcile). */
export interface ReconcileRow {
  readonly kind: 'account' | 'sub_account';
  readonly accountId: string;
  readonly subjectId: string | null;
  readonly balance: bigint;
  readonly ledgerSum: bigint;
  /** `balance − ledgerSum` — non-zero flags an integrity gap (see contract note). */
  readonly drift: bigint;
}

/**
 * Reconcile a tenant's pool account(s): stored `credit_balance` vs the sum of the
 * account's `ledger_txn.credits_delta`. drift should be 0 when every balance
 * change is ledgered (topup/settle/transfer). Sub-wallet reconcile is deferred to
 * records v2 (the single-entry ledger keys rows on the pool account).
 */
export async function reconcileTenant(db: DbOrTx, tenantId: string): Promise<ReconcileRow[]> {
  const accts = await db
    .select({ id: account.id, balance: account.creditBalance })
    .from(account)
    .where(and(eq(account.tenantId, tenantId), isNull(account.deletedAt)));
  const out: ReconcileRow[] = [];
  for (const a of accts) {
    const rows = await db
      .select({ s: sql<string>`coalesce(sum(${ledgerTxn.creditsDelta}), 0)` })
      .from(ledgerTxn)
      .where(eq(ledgerTxn.accountId, a.id));
    const ledgerSum = BigInt(rows[0]?.s ?? '0');
    out.push({
      kind: 'account',
      accountId: a.id,
      subjectId: null,
      balance: a.balance,
      ledgerSum,
      drift: a.balance - ledgerSum,
    });
  }
  return out;
}
