import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, lt } from 'drizzle-orm';

import { session } from '../schema/index.js';
import type { DbOrTx } from './types.js';

/** The principal kind a session re-mints on refresh. */
export type SessionPrincipalKind = 'user' | 'subject' | 'admin';

/** Compute the stored lookup hash for a refresh token (sha256 hex). Mirrors {@link hashAdminToken}. */
export function hashRefreshToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Mint a new one-time refresh-token plaintext (`rt_<base64url(32 bytes)>`). The
 * `rt_` prefix distinguishes it from the `at_` admin service token + `ak_` api
 * key. Returned ONCE — only its {@link hashRefreshToken} is ever persisted.
 */
export function generateRefreshToken(): string {
  return `rt_${randomBytes(32).toString('base64url')}`;
}

/** Fields a caller supplies to {@link createSession}. */
export interface CreateSessionInput {
  readonly principalKind: SessionPrincipalKind;
  /** Set for a `user` session; NULL for `subject`/`admin`. */
  readonly userId?: string | null | undefined;
  /** Set for a `subject` session; NULL for `user`/`admin`. */
  readonly subjectId?: string | null | undefined;
  /** The tenant scope re-minted into a subject token; null otherwise. */
  readonly tenantId?: string | null | undefined;
  /** sha256 hex of the one-time refresh plaintext (the caller hashes it). */
  readonly refreshHash: string;
  /** Stable lineage id; reused across rotations of one login. */
  readonly familyId: string;
  /** Hard expiry of the refresh token. */
  readonly expiresAt: Date;
  readonly userAgent?: string | null | undefined;
  readonly ip?: string | null | undefined;
}

/** The session row used by the refresh flow (NEVER re-derives the plaintext). */
export interface SessionRow {
  readonly id: string;
  readonly principalKind: string;
  readonly userId: string | null;
  readonly subjectId: string | null;
  readonly tenantId: string | null;
  readonly refreshHash: string;
  readonly familyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly replacedBy: string | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SESSION_COLUMNS = {
  id: session.id,
  principalKind: session.principalKind,
  userId: session.userId,
  subjectId: session.subjectId,
  tenantId: session.tenantId,
  refreshHash: session.refreshHash,
  familyId: session.familyId,
  issuedAt: session.issuedAt,
  expiresAt: session.expiresAt,
  revokedAt: session.revokedAt,
  lastUsedAt: session.lastUsedAt,
  replacedBy: session.replacedBy,
  userAgent: session.userAgent,
  ip: session.ip,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
} as const;

/**
 * Persist a new login session. Stores ONLY the `refresh_hash` — the caller has
 * already hashed the one-time plaintext, which never touches the db. Returns the
 * created row (no plaintext, by construction).
 */
export async function createSession(db: DbOrTx, input: CreateSessionInput): Promise<SessionRow> {
  const rows = await db
    .insert(session)
    .values({
      principalKind: input.principalKind,
      userId: input.userId ?? null,
      subjectId: input.subjectId ?? null,
      tenantId: input.tenantId ?? null,
      refreshHash: input.refreshHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    .returning(SESSION_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error('createSession: insert returned no row');
  return row;
}

/**
 * Look up a session by refresh-token hash, returning it ONLY when still LIVE —
 * not revoked and not past `expires_at`. A revoked or expired hash resolves to
 * `undefined`. This is the correctness boundary (the table is not append-only):
 * the refresh flow distinguishes "live" from "revoked-but-present" by calling
 * {@link findSessionByHashAnyState} after a miss to detect reuse/theft.
 */
export async function findLiveSessionByHash(
  db: DbOrTx,
  hash: string,
): Promise<SessionRow | undefined> {
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(session)
    .where(and(eq(session.refreshHash, hash), isNull(session.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return undefined;
  // Expiry is checked in JS (cheaper to read clearly than a SQL `now()` clause).
  if (row.expiresAt.getTime() <= Date.now()) return undefined;
  return row;
}

/**
 * Look a session up by hash in ANY state (including revoked/expired). Used by the
 * refresh flow ONLY for reuse detection: a presented refresh whose hash matches a
 * REVOKED row means the token was already rotated — i.e. a stolen/replayed token —
 * so the caller revokes the whole family.
 */
export async function findSessionByHashAnyState(
  db: DbOrTx,
  hash: string,
): Promise<SessionRow | undefined> {
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(session)
    .where(eq(session.refreshHash, hash))
    .limit(1);
  return rows[0];
}

/** Fields a caller supplies to {@link rotateSession} for the replacement row. */
export interface RotateSessionInput {
  readonly refreshHash: string;
  readonly expiresAt: Date;
  readonly userAgent?: string | null | undefined;
  readonly ip?: string | null | undefined;
}

/**
 * Rotate a session: insert a fresh row in the SAME family carrying the next
 * refresh hash, then stamp the old row `revoked_at` + `replaced_by` (so a replay
 * of the old token is detectable). Done in a transaction so the pair is atomic.
 * Returns the new live row. The old row's principal linkage is copied forward.
 */
export async function rotateSession(
  db: DbOrTx,
  old: SessionRow,
  next: RotateSessionInput,
): Promise<SessionRow> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(session)
      .values({
        principalKind: old.principalKind,
        userId: old.userId,
        subjectId: old.subjectId,
        tenantId: old.tenantId,
        refreshHash: next.refreshHash,
        familyId: old.familyId,
        expiresAt: next.expiresAt,
        userAgent: next.userAgent ?? old.userAgent,
        ip: next.ip ?? old.ip,
      })
      .returning(SESSION_COLUMNS);
    const newRow = inserted[0];
    if (!newRow) throw new Error('rotateSession: insert returned no row');
    const now = new Date();
    await tx
      .update(session)
      .set({ revokedAt: now, replacedBy: newRow.id, lastUsedAt: now, updatedAt: now })
      .where(and(eq(session.id, old.id), isNull(session.revokedAt)));
    return newRow;
  });
}

/** Revoke a single session by id (idempotent: only flips a still-live row). Returns its id, or undefined. */
export async function revokeSession(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(session)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(session.id, id), isNull(session.revokedAt)))
    .returning({ id: session.id });
  return rows[0]?.id;
}

/**
 * Revoke EVERY live session in a family (reuse/theft response, or "log out
 * everywhere"). Returns the count revoked. A re-run is a safe no-op (only live
 * rows match).
 */
export async function revokeFamily(db: DbOrTx, familyId: string): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(session)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(session.familyId, familyId), isNull(session.revokedAt)))
    .returning({ id: session.id });
  return rows.length;
}

/**
 * Revoke EVERY live session belonging to a principal (a `user` operator or a
 * `subject` end-user). Called when the principal's authority changes — disable,
 * password change, or subject soft-delete — so a refresh (which re-mints an
 * access token from a live session WITHOUT re-checking the principal's current
 * status) can no longer extend access for a revoked/rotated principal. Idempotent
 * (only live rows match); returns the count revoked.
 */
export async function revokeSessionsForPrincipal(
  db: DbOrTx,
  principal: { userId: string } | { subjectId: string },
): Promise<number> {
  const now = new Date();
  const match =
    'userId' in principal
      ? eq(session.userId, principal.userId)
      : eq(session.subjectId, principal.subjectId);
  const rows = await db
    .update(session)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(match, isNull(session.revokedAt)))
    .returning({ id: session.id });
  return rows.length;
}

/**
 * Hard-delete sessions whose `expires_at` is older than `cutoff` (a future
 * periodic sweep — not wired to a worker job in this slice). Returns the count
 * deleted. The table is NOT append-only, so a plain DELETE is permitted.
 */
export async function sweepExpiredSessions(db: DbOrTx, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(session)
    .where(lt(session.expiresAt, cutoff))
    .returning({ id: session.id });
  return rows.length;
}
