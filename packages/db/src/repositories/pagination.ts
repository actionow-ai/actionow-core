import type { Column, SQL, Table } from 'drizzle-orm';
import { and, desc, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import type { DbOrTx } from './types.js';

/**
 * A decoded keyset position: the `created_at` + tiebreaker `id` (uuid / resource
 * slug / redemption code) of the LAST row of the previous page. The next page
 * filters strictly past it, `(created_at, id) < (createdAt, id)` under the
 * uniform `ORDER BY created_at DESC, id DESC`.
 */
export interface KeysetCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** A typed page request: a clamped `limit` plus an optional keyset `cursor`. */
export interface PageParams {
  readonly cursor?: KeysetCursor | undefined;
  readonly limit: number;
}

/** A trimmed page of rows + whether a further page exists. */
export interface KeysetResult<T> {
  /** The page, trimmed to `params.limit`, ordered `created_at DESC, id DESC`. */
  readonly rows: T[];
  /** `true` iff a `limit + 1`-th row came back (a next page exists). */
  readonly hasMore: boolean;
}

/** Inputs to {@link keysetPage}. */
export interface KeysetPageInput {
  /** The Drizzle table to page over. */
  readonly table: Table;
  /** The `created_at` column (the primary keyset sort key). */
  readonly createdAtCol: Column;
  /** The PK / tiebreaker column (`uuid` id, `text` resource id, or `code`). */
  readonly idCol: Column;
  /**
   * An optional explicit column projection (`db.select(selection)`). Used by
   * list repos that must NOT select every column — e.g. `listApiKeys` omits the
   * `hash`, `listOAuthSessions` omits the token ciphertext. Omit for `SELECT *`.
   */
  readonly selection?: Record<string, PgColumn | SQL | SQL.Aliased> | undefined;
  /** An extra `WHERE` fragment (tenant/resource/status filters) AND-ed in. */
  readonly where?: SQL | undefined;
  /** The page request (limit + optional cursor). */
  readonly page: PageParams;
}

/**
 * The uniform keyset-pagination primitive every `list*` repo composes on.
 *
 * Builds `WHERE <filter> AND (created_at, id) < (cursor.createdAt, cursor.id)`
 * — expressed as the standard compound predicate
 * `created_at < c OR (created_at = c AND id < cid)` so it uses a single direction
 * of the `(created_at DESC, id DESC)` order — orders newest-first with the id as
 * the deterministic tiebreaker, and fetches `limit + 1` rows. If the extra row
 * came back there is a next page (`hasMore`), and the slice is trimmed back to
 * `limit`. The tiebreaker comparison casts both sides to `text` so it works
 * uniformly for `uuid`, `text`, and `code` PK columns.
 */
export async function keysetPage<T = Record<string, unknown>>(
  db: DbOrTx,
  input: KeysetPageInput,
): Promise<KeysetResult<T>> {
  const { table, createdAtCol, idCol, selection, where, page } = input;

  const predicates: SQL[] = [];
  if (where !== undefined) predicates.push(where);
  if (page.cursor !== undefined) {
    const { createdAt, id } = page.cursor;
    // (created_at, id) < (c, cid): created_at < c OR (created_at = c AND id < cid),
    // written as a single `sql` fragment. The cursor `created_at` is bound as an
    // ISO string cast to `timestamptz` (the postgres driver binds Date params as
    // text, so we cast explicitly); the id comparison casts both sides to `text`
    // so uuid / text / code PKs all compare uniformly.
    const c = sql`${createdAt.toISOString()}::timestamptz`;
    predicates.push(
      sql`(${createdAtCol} < ${c} OR (${createdAtCol} = ${c} AND ${idCol}::text < ${id}))`,
    );
  }
  const whereClause = predicates.length === 0 ? undefined : and(...predicates);

  const base = selection === undefined ? db.select() : db.select(selection);
  const rows = (await base
    .from(table)
    .where(whereClause)
    .orderBy(desc(createdAtCol), desc(idCol))
    .limit(page.limit + 1)) as T[];

  const hasMore = rows.length > page.limit;
  return { rows: hasMore ? rows.slice(0, page.limit) : rows, hasMore };
}
