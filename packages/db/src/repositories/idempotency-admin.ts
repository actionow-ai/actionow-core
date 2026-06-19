import { and, eq } from 'drizzle-orm';

import { requestIdempotency } from '../schema/index.js';
import type { DbOrTx } from './types.js';

/**
 * A previously-captured admin POST response, replayed verbatim on a duplicate
 * request carrying the same `Idempotency-Key` (and same route `scope`).
 */
export interface IdempotentResponse {
  readonly status: number;
  readonly body: unknown;
  /** sha256 hex of the original request body, or null for pre-P3 rows. */
  readonly fingerprint: string | null;
}

/**
 * Fetch the stored response for `(key, scope)` if one exists. A miss returns
 * `undefined` (the caller then runs the handler and persists the fresh result).
 */
export async function getIdempotentResponse(
  db: DbOrTx,
  key: string,
  scope: string,
): Promise<IdempotentResponse | undefined> {
  const rows = await db
    .select({
      status: requestIdempotency.responseStatus,
      body: requestIdempotency.responseBody,
      fingerprint: requestIdempotency.requestFingerprint,
    })
    .from(requestIdempotency)
    .where(and(eq(requestIdempotency.idKey, key), eq(requestIdempotency.scope, scope)))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  return { status: row.status, body: row.body, fingerprint: row.fingerprint };
}

/** Fields persisted by {@link putIdempotentResponse}. */
export interface PutIdempotentResponseInput {
  readonly key: string;
  readonly scope: string;
  readonly status: number;
  readonly body: unknown;
  /** sha256 hex of the request body, stored so a later reuse can be payload-checked. */
  readonly fingerprint?: string;
}

/**
 * Persist the first response for `(key, scope)`. The write is
 * `INSERT … ON CONFLICT (id_key, scope) DO NOTHING`, so a concurrent in-flight
 * duplicate (a second request that computed its own response before this row
 * landed) does NOT error and does NOT overwrite the winner — it is simply a
 * no-op. Returns `true` when this call inserted the row, `false` when the row
 * already existed (the concurrent-duplicate race).
 *
 * Best-effort by contract: the interceptor wraps this in a try/catch so a store
 * failure never fails the underlying admin request.
 */
export async function putIdempotentResponse(
  db: DbOrTx,
  input: PutIdempotentResponseInput,
): Promise<boolean> {
  const inserted = await db
    .insert(requestIdempotency)
    .values({
      idKey: input.key,
      scope: input.scope,
      responseStatus: input.status,
      responseBody: input.body,
      ...(input.fingerprint !== undefined ? { requestFingerprint: input.fingerprint } : {}),
    })
    .onConflictDoNothing({ target: [requestIdempotency.idKey, requestIdempotency.scope] })
    .returning({ idKey: requestIdempotency.idKey });

  return inserted.length === 1;
}
