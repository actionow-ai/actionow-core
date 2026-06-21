import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, like } from 'drizzle-orm';

import { fileObject } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type FileObject = InferSelectModel<typeof fileObject>;

/**
 * Fields a caller supplies to {@link createFileObject}. `id`, `status` (defaults
 * to `pending`), and `createdAt` are DB-managed; `size`/`contentType`/`etag` are
 * unknown until the upload is confirmed and so are omitted here.
 */
export type CreateFileObjectInput = Omit<
  InferInsertModel<typeof fileObject>,
  'id' | 'status' | 'size' | 'contentType' | 'etag' | 'createdAt'
>;

/** Metadata observed via `head` once an upload completes. */
export interface FileReadyInput {
  size?: number;
  contentType?: string;
  etag?: string;
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
): Promise<FileObject | undefined> {
  const where =
    tenantId === undefined
      ? eq(fileObject.id, id)
      : and(eq(fileObject.id, id), eq(fileObject.tenantId, tenantId));
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
): Promise<KeysetResult<FileObject>> {
  const predicates: SQL[] = [eq(fileObject.tenantId, tenantId)];
  if (filter.status !== undefined) predicates.push(eq(fileObject.status, filter.status));
  if (filter.kind !== undefined) predicates.push(like(fileObject.contentType, `${filter.kind}/%`));

  return keysetPage<FileObject>(db, {
    table: fileObject,
    createdAtCol: fileObject.createdAt,
    idCol: fileObject.id,
    where: and(...predicates),
    page,
  });
}
