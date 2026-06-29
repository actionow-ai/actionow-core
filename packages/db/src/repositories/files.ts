import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';

import { account, fileObject } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type FileObject = InferSelectModel<typeof fileObject>;

/**
 * Read-path subject isolation (§4b): a subject-scoped caller sees its own assets
 * plus tenant-shared (`subject_id IS NULL`) ones; a `null` subject (tenant-level
 * caller) imposes no filter. Cross-subject files are excluded.
 */
function fileSubjectScope(subjectId: string | null): SQL | undefined {
  return subjectId === null
    ? undefined
    : or(eq(fileObject.subjectId, subjectId), isNull(fileObject.subjectId));
}

/**
 * Fields a caller supplies to {@link createFileObject}. `id`, `status` (defaults
 * to `pending`), and `createdAt` are DB-managed; `size`/`contentType`/`etag` are
 * unknown until the upload is confirmed and so are omitted here.
 */
export type CreateFileObjectInput = Omit<
  InferInsertModel<typeof fileObject>,
  'id' | 'status' | 'size' | 'contentType' | 'etag' | 'width' | 'height' | 'duration' | 'createdAt'
>;

/** Metadata observed via `head` once an upload completes (media dims added in P1). */
export interface FileReadyInput {
  size?: number;
  contentType?: string;
  etag?: string;
  /** Media metadata (P1) — pixel dims for image/video, seconds for video/audio. */
  width?: number;
  height?: number;
  duration?: number;
}

/** Insert a `file_object` reference in status `pending`. */
export async function createFileObject(
  db: DbOrTx,
  input: CreateFileObjectInput,
): Promise<FileObject> {
  const rows = await db
    .insert(fileObject)
    .values({ ...input, status: 'pending' })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createFileObject: insert returned no row');
  return row;
}

/**
 * Mark a pending file as `ready` and record the observed object metadata.
 * Returns the updated row, or `undefined` if no matching file exists.
 */
export async function markFileReady(
  db: DbOrTx,
  id: string,
  meta: FileReadyInput,
): Promise<FileObject | undefined> {
  const rows = await db
    .update(fileObject)
    .set({
      status: 'ready',
      ...(meta.size !== undefined ? { size: meta.size } : {}),
      ...(meta.contentType !== undefined ? { contentType: meta.contentType } : {}),
      ...(meta.etag !== undefined ? { etag: meta.etag } : {}),
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
      ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
    })
    .where(eq(fileObject.id, id))
    .returning();
  return rows[0];
}

/**
 * Fetch a file reference by id. When `tenantId` is supplied the lookup is
 * tenant-scoped (returns `undefined` for another tenant's file), which callers
 * use to enforce isolation.
 */
export async function getFileObject(
  db: DbOrTx,
  id: string,
  tenantId?: string,
  subjectId: string | null = null,
): Promise<FileObject | undefined> {
  const where =
    tenantId === undefined
      ? eq(fileObject.id, id)
      : and(
          eq(fileObject.id, id),
          eq(fileObject.tenantId, tenantId),
          isNull(fileObject.deletedAt),
          fileSubjectScope(subjectId),
        );
  const rows = await db.select().from(fileObject).where(where).limit(1);
  return rows[0];
}

/** Filters for {@link listFilesByTenant} (all optional; AND-ed with the tenant scope). */
export interface ListFilesFilter {
  /** Only files in this lifecycle state (e.g. `ready` for the asset gallery). */
  readonly status?: 'pending' | 'ready';
  /** Only files whose `content_type` starts with `image/`, `video/`, or `audio/`. */
  readonly kind?: 'image' | 'video' | 'audio';
}

/**
 * Keyset-paginate a tenant's `file_object` rows (newest-first), optionally
 * narrowed to a lifecycle `status` and/or media `kind`. Rows with a NULL
 * `content_type` are excluded when a `kind` filter is set (the `LIKE` cannot
 * match NULL). Tenant isolation is enforced by the leading `tenant_id` predicate.
 */
export function listFilesByTenant(
  db: DbOrTx,
  tenantId: string,
  filter: ListFilesFilter,
  page: PageParams,
  subjectId: string | null = null,
): Promise<KeysetResult<FileObject>> {
  const predicates: SQL[] = [eq(fileObject.tenantId, tenantId), isNull(fileObject.deletedAt)];
  if (filter.status !== undefined) predicates.push(eq(fileObject.status, filter.status));
  if (filter.kind !== undefined) predicates.push(like(fileObject.contentType, `${filter.kind}/%`));
  const scope = fileSubjectScope(subjectId);
  if (scope !== undefined) predicates.push(scope);

  return keysetPage<FileObject>(db, {
    table: fileObject,
    createdAtCol: fileObject.createdAt,
    idCol: fileObject.id,
    where: and(...predicates),
    page,
  });
}

/**
 * Soft-delete a tenant/subject-owned file: stamp `deleted_at` (idempotent — only
 * a still-LIVE row moves). Returns the row (for its `key`) or `undefined` when no
 * matching live file exists. The actual object removal is the caller's
 * best-effort storage `delete(key)`.
 */
export async function softDeleteFile(
  db: DbOrTx,
  id: string,
  tenantId: string,
  subjectId: string | null = null,
): Promise<FileObject | undefined> {
  const now = new Date();
  const rows = await db
    .update(fileObject)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(fileObject.id, id),
        eq(fileObject.tenantId, tenantId),
        isNull(fileObject.deletedAt),
        fileSubjectScope(subjectId),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * Live object-storage usage for a tenant: total bytes (Σ `size`) + file count,
 * excluding soft-deleted rows. `size` is NULL until an upload is confirmed, so a
 * pending reference contributes 0 bytes (but is counted). Drives quota checks +
 * the `/v1/files/usage` read.
 */
export async function getStorageUsage(
  db: DbOrTx,
  tenantId: string,
): Promise<{ bytes: number; count: number }> {
  const [row] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${fileObject.size}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(fileObject)
    .where(and(eq(fileObject.tenantId, tenantId), isNull(fileObject.deletedAt)));
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.count ?? 0) };
}

/**
 * Per-tenant object-storage quota override (bytes) from
 * `account.config.storage_quota_bytes`, or `undefined` when unset/invalid (the
 * caller then falls back to the global `STORAGE_TENANT_QUOTA_BYTES` env default).
 */
export async function getTenantStorageQuota(
  db: DbOrTx,
  tenantId: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ config: account.config })
    .from(account)
    .where(eq(account.tenantId, tenantId))
    .limit(1);
  const q = row?.config.storage_quota_bytes;
  return typeof q === 'number' && Number.isFinite(q) && q > 0 ? q : undefined;
}

/**
 * A tenant eligible for the opt-in file lifecycle / TTL sweep, with the effective
 * retention window in days. STRICTLY POSITIVE by construction (see
 * {@link listTenantsWithFileTtl}).
 */
export interface TenantFileTtl {
  tenantId: string;
  ttlDays: number;
}

/**
 * The opt-in eligibility list for the worker's file-lifecycle sweep. Reads every
 * LIVE account (one per tenant) and computes each tenant's effective TTL:
 * `account.config.file_ttl_days` when it is a strictly-positive finite number,
 * else the `platformDefaultDays` fallback. Only tenants whose effective TTL is
 * STRICTLY POSITIVE are returned — so a tenant with no per-tenant override AND no
 * platform default is OMITTED (files retained forever, the safe default).
 *
 * DATA-LOSS CRITICAL: a 0 / absent / null / non-finite `file_ttl_days` must NEVER
 * be treated as eligible (that would mass-delete app-referenced files). The
 * predicate below is the single guard for that invariant.
 */
export async function listTenantsWithFileTtl(
  db: DbOrTx,
  platformDefaultDays?: number,
): Promise<TenantFileTtl[]> {
  const rows = await db
    .select({ tenantId: account.tenantId, config: account.config })
    .from(account)
    .where(isNull(account.deletedAt));
  const out: TenantFileTtl[] = [];
  for (const row of rows) {
    const override = row.config.file_ttl_days;
    const perTenant =
      typeof override === 'number' && Number.isFinite(override) && override > 0
        ? override
        : undefined;
    const effective = perTenant ?? platformDefaultDays;
    if (effective !== undefined && effective > 0) {
      out.push({ tenantId: row.tenantId, ttlDays: effective });
    }
  }
  return out;
}

/**
 * One bounded batch of a tenant's LIVE files created before `cutoff`, returning
 * `{id, key}` so the sweep can best-effort remove the bucket object then
 * soft-delete the row. Excludes already-tombstoned rows (`deleted_at IS NULL`) so
 * repeated sweeps converge; scoped to the single `tenantId`.
 */
export function listLiveFilesOlderThanForTenant(
  db: DbOrTx,
  tenantId: string,
  cutoff: Date,
  limit: number,
): Promise<{ id: string; key: string }[]> {
  return db
    .select({ id: fileObject.id, key: fileObject.key })
    .from(fileObject)
    .where(
      and(
        eq(fileObject.tenantId, tenantId),
        lt(fileObject.createdAt, cutoff),
        isNull(fileObject.deletedAt),
      ),
    )
    .limit(limit);
}

/**
 * Batched soft-delete: stamp `deleted_at`/`updated_at` on every still-LIVE row in
 * `ids` (idempotent — an already-tombstoned row is skipped by the
 * `deleted_at IS NULL` guard, so a re-sweep is a no-op). Returns the number of
 * rows tombstoned. An empty `ids` is a 0-row no-op (no SQL). The per-row
 * {@link softDeleteFile} stays the API delete path; this is the bulk sweep path.
 *
 * `file_object` is NOT in the append-only trigger set (mig 0052), so the
 * `deleted_at` UPDATE is permitted.
 */
export async function markFileObjectsDeleted(db: DbOrTx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date();
  const rows = await db
    .update(fileObject)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(inArray(fileObject.id, ids), isNull(fileObject.deletedAt)))
    .returning({ id: fileObject.id });
  return rows.length;
}

/**
 * Per-tenant file TTL override (days) from `account.config.file_ttl_days`, or
 * `null` when unset/invalid (mirrors {@link getTenantStorageQuota}). Only a
 * strictly-positive finite number is returned; the caller falls back to the
 * `FILE_RETENTION_DAYS` env default (and ultimately `null` → retain forever).
 */
export async function getTenantFileTtlDays(db: DbOrTx, tenantId: string): Promise<number | null> {
  const [row] = await db
    .select({ config: account.config })
    .from(account)
    .where(eq(account.tenantId, tenantId))
    .limit(1);
  const d = row?.config.file_ttl_days;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null;
}
