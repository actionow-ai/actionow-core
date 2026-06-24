import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, isNull, like, or } from 'drizzle-orm';

import { fileObject } from '../schema/index.js';
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
      : and(eq(fileObject.id, id), eq(fileObject.tenantId, tenantId), fileSubjectScope(subjectId));
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
  const predicates: SQL[] = [eq(fileObject.tenantId, tenantId)];
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
