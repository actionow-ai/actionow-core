import type { KeysetResult, PageParams } from '@actionow/db';

import { engineInvalidInput } from './errors.js';

/** Default page size when `limit` is absent or unparseable. */
const DEFAULT_LIMIT = 50;
/** Hard upper bound on a page; a larger `limit` is clamped down to this. */
const MAX_LIMIT = 200;
/** Lower bound; a `limit` below this is clamped up to this. */
const MIN_LIMIT = 1;

/** The raw `limit`/`cursor` query params as they arrive (strings or absent). */
export interface PageQuery {
  readonly limit?: string | undefined;
  readonly cursor?: string | undefined;
}

/** A parsed page request: a clamped `limit` + the opaque `cursor` (untouched). */
export interface ParsedPageQuery {
  readonly limit: number;
  readonly cursor?: string;
}

/** The uniform list response envelope (§ pagination convention, BREAKING). */
export interface PageEnvelope<T> {
  /** The page of rows (already trimmed to `limit` by the repo). */
  readonly data: T[];
  /** The cursor to fetch the next page, or `null` when there is no next page. */
  readonly next_cursor: string | null;
  /** `true` iff a further page exists (the repo saw a `limit + 1`-th row). */
  readonly has_more: boolean;
}

/**
 * Clamp the `limit` query param to `[1, 200]` (default 50 when absent/NaN) and
 * pass the opaque `cursor` string through unchanged. Pure — never throws; cursor
 * validity is checked lazily by {@link decodeCursor}/{@link toPageParams}.
 */
export function parsePageQuery(q: PageQuery): ParsedPageQuery {
  const parsed = q.limit === undefined ? DEFAULT_LIMIT : Number.parseInt(q.limit, 10);
  const limit = Number.isNaN(parsed)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(MIN_LIMIT, parsed), MAX_LIMIT);
  return q.cursor === undefined ? { limit } : { limit, cursor: q.cursor };
}

/**
 * Encode a `(created_at, id)` keyset position as an opaque base64url cursor of
 * `"<created_at_iso>|<id>"`. The id (uuid / resource slug / redemption code) is
 * the tiebreaker; it never contains the `|` delimiter, so the decoder splits on
 * the FIRST pipe and the id round-trips verbatim.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into its `(createdAt, id)` keyset position.
 * Throws on any malformed input — not base64url, missing the `|` delimiter, or
 * an unparseable date. Callers at the HTTP boundary map the throw to a 400
 * `invalid_input` (see {@link toPageParams}).
 */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const pipe = decoded.indexOf('|');
  if (pipe < 0) {
    throw new Error('cursor: missing delimiter');
  }
  const iso = decoded.slice(0, pipe);
  const id = decoded.slice(pipe + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error('cursor: invalid created_at');
  }
  return { createdAt, id };
}

/**
 * Combine {@link parsePageQuery} + {@link decodeCursor} into the {@link PageParams}
 * a list repo consumes: the clamped `limit` plus the decoded `(createdAt, id)`
 * keyset position (omitted when no cursor was supplied). A malformed cursor is
 * mapped to a 400 `invalid_input` engine error so the unified filter renders the
 * §4.7 envelope rather than a 500.
 */
export function toPageParams(q: PageQuery): PageParams {
  const { limit, cursor } = parsePageQuery(q);
  if (cursor === undefined) {
    return { limit };
  }
  try {
    return { limit, cursor: decodeCursor(cursor) };
  } catch {
    throw engineInvalidInput('invalid cursor');
  }
}

/**
 * Build the uniform list envelope from an already-trimmed page of `rows` plus
 * the keyset helper's `hasMore` flag. `next_cursor` encodes the LAST row's
 * `(created_at, id)` — the exclusive bound the next page filters past — and is
 * `null` when `!hasMore` (or the page is empty). `idOf` extracts the row's
 * tiebreaker (uuid / slug / code); every list row carries `createdAt`.
 */
export function toPageEnvelope<T extends { createdAt: Date }>(
  rows: T[],
  hasMore: boolean,
  idOf: (row: T) => string,
): PageEnvelope<T> {
  const last = rows.at(-1);
  const next_cursor =
    hasMore && last !== undefined ? encodeCursor(last.createdAt, idOf(last)) : null;
  return { data: rows, next_cursor, has_more: next_cursor !== null };
}

/**
 * Build a list envelope from a repo's {@link KeysetResult} while projecting each
 * raw row to a serialized view. The `next_cursor` is derived from the LAST RAW
 * row's `(created_at, id)` — so it stays a true keyset position even though the
 * view (`toView`) may render `created_at` as an ISO string or drop the id. Used
 * by every controller whose response rows are snake_case views over the raw db
 * row (the common case).
 */
export function mapPageEnvelope<R extends { createdAt: Date }, V>(
  result: KeysetResult<R>,
  idOf: (row: R) => string,
  toView: (row: R) => V,
): PageEnvelope<V> {
  const { rows, hasMore } = result;
  const last = rows.at(-1);
  const next_cursor =
    hasMore && last !== undefined ? encodeCursor(last.createdAt, idOf(last)) : null;
  return { data: rows.map(toView), next_cursor, has_more: next_cursor !== null };
}
