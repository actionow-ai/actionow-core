import type { InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';

import { decryptSecret, encryptSecret } from '../crypto.js';
import { oauthSession, secretRef } from '../schema/index.js';
import type { SecretRefRow } from './catalog.js';
import type { DbOrTx } from './types.js';

/** A raw `oauth_session` row — `accessEnc`/`refreshEnc` are AES-GCM ciphertext. */
export type OAuthSessionRow = InferSelectModel<typeof oauthSession>;

/** Default singleflight lock staleness (ms): a held lock older than this is reclaimable. */
const REFRESH_LOCK_STALE_MS = 90_000;

/** Fields a caller supplies to {@link createOAuthSession}. */
export interface CreateOAuthSessionInput {
  /** The OAuth provider kind (e.g. `codex`). */
  readonly providerKind: string;
  /** The plaintext access token — encrypted before insert, never persisted in the clear. */
  readonly accessToken: string;
  /** The plaintext refresh token — encrypted before insert, never persisted in the clear. */
  readonly refreshToken: string;
  /** Base64 AES-256 master key used to encrypt both tokens. */
  readonly keyB64: string;
  /** Optional human label; also stored as the `secret_ref` locator (defaults to `''`). */
  readonly accountLabel?: string | undefined;
  /** Optional provider account id (e.g. parsed from the access token JWT). */
  readonly accountId?: string | undefined;
  /** Optional access-token expiry; drives the refresh sweep. */
  readonly expiresAt?: Date | undefined;
}

/**
 * Create a `provider='oauth'` secret_ref + its 1:1 `oauth_session` row in one
 * transaction. Both tokens are AES-GCM-encrypted before insert; only ciphertext
 * is persisted. Returns the `secret_ref` row (its id is the session pk + the
 * credential ref channels point at).
 */
export async function createOAuthSession(
  db: DbOrTx,
  input: CreateOAuthSessionInput,
): Promise<SecretRefRow> {
  const accessEnc = encryptSecret(input.accessToken, input.keyB64);
  const refreshEnc = encryptSecret(input.refreshToken, input.keyB64);
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .insert(secretRef)
      .values({ provider: 'oauth', locator: input.accountLabel ?? '' })
      .returning();
    if (!ref) throw new Error('createOAuthSession: secret_ref insert returned no row');
    await tx.insert(oauthSession).values({
      secretRefId: ref.id,
      providerKind: input.providerKind,
      accountLabel: input.accountLabel ?? null,
      accountId: input.accountId ?? null,
      accessEnc,
      refreshEnc,
      expiresAt: input.expiresAt ?? null,
    });
    return ref;
  });
}

/**
 * Fetch the raw `oauth_session` row (ciphertext tokens) by its `secret_ref` id,
 * or `undefined`. For the worker/lock path that does not need plaintext.
 */
export async function getOAuthSession(
  db: DbOrTx,
  secretRefId: string,
): Promise<OAuthSessionRow | undefined> {
  const rows = await db
    .select()
    .from(oauthSession)
    .where(and(eq(oauthSession.secretRefId, secretRefId), isNull(oauthSession.deletedAt)))
    .limit(1);
  return rows[0];
}

/** The decrypted view of an `oauth_session` (plaintext tokens) — never logged. */
export interface DecryptedOAuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly providerKind: string;
  readonly accountId: string | null;
  readonly expiresAt: Date | null;
  readonly status: string;
}

/**
 * Fetch an `oauth_session` and decrypt its tokens with `keyB64`. Returns
 * `undefined` when no row exists. The ONLY path that yields plaintext tokens;
 * a bad key / tampered ciphertext throws (callers handle re-auth).
 */
export async function getDecryptedOAuthSession(
  db: DbOrTx,
  secretRefId: string,
  keyB64: string,
): Promise<DecryptedOAuthSession | undefined> {
  const row = await getOAuthSession(db, secretRefId);
  if (row === undefined) return undefined;
  return {
    accessToken: decryptSecret(row.accessEnc, keyB64),
    refreshToken: decryptSecret(row.refreshEnc, keyB64),
    providerKind: row.providerKind,
    accountId: row.accountId,
    expiresAt: row.expiresAt,
    status: row.status,
  };
}

/**
 * DB-level singleflight refresh lock. Atomically stamps `refresh_lock_at = now`
 * only when the lock is free — `refresh_lock_at IS NULL` OR a stale lock older
 * than `now - staleMs` (a crashed refresher). The conditional `UPDATE …
 * RETURNING` makes the claim a single atomic write: exactly one concurrent
 * caller's `WHERE` matches, so exactly one gets a row back. Returns `true` when
 * this caller won the lock, `false` when another holds a live lock.
 */
export async function claimRefreshLock(
  db: DbOrTx,
  secretRefId: string,
  now: Date,
  staleMs: number = REFRESH_LOCK_STALE_MS,
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - staleMs);
  const rows = await db
    .update(oauthSession)
    .set({ refreshLockAt: now })
    .where(
      and(
        eq(oauthSession.secretRefId, secretRefId),
        or(isNull(oauthSession.refreshLockAt), lt(oauthSession.refreshLockAt, staleBefore)),
      ),
    )
    .returning({ secretRefId: oauthSession.secretRefId });
  return rows.length > 0;
}

/** Fields a caller supplies to {@link updateOAuthTokens}. */
export interface UpdateOAuthTokensInput {
  /** The freshly-minted plaintext access token — re-encrypted before write. */
  readonly accessToken: string;
  /** The freshly-minted plaintext refresh token — re-encrypted before write. */
  readonly refreshToken: string;
  /** The new access-token expiry. */
  readonly expiresAt: Date;
  /** Base64 AES-256 master key used to encrypt both tokens. */
  readonly keyB64: string;
  /** The refresh timestamp; stamped on `last_refresh_at`/`updated_at`. */
  readonly now: Date;
}

/**
 * Rotate an `oauth_session`'s tokens after a successful refresh: re-encrypts
 * both tokens, sets the new `expires_at`, stamps `last_refresh_at`/`updated_at`,
 * and clears `refresh_lock_at` (releasing the singleflight lock).
 */
export async function updateOAuthTokens(
  db: DbOrTx,
  secretRefId: string,
  input: UpdateOAuthTokensInput,
): Promise<void> {
  await db
    .update(oauthSession)
    .set({
      accessEnc: encryptSecret(input.accessToken, input.keyB64),
      refreshEnc: encryptSecret(input.refreshToken, input.keyB64),
      expiresAt: input.expiresAt,
      lastRefreshAt: input.now,
      refreshLockAt: null,
      updatedAt: input.now,
    })
    .where(eq(oauthSession.secretRefId, secretRefId));
}

/**
 * Mark an `oauth_session` as needing operator re-authentication (e.g. the
 * refresh token was revoked). Sets `status='needs_reauth'` and clears the lock
 * so the sweep stops attempting it.
 */
export async function markNeedsReauth(db: DbOrTx, secretRefId: string): Promise<void> {
  await db
    .update(oauthSession)
    .set({ status: 'needs_reauth', refreshLockAt: null })
    .where(eq(oauthSession.secretRefId, secretRefId));
}

/**
 * A token-free `oauth_session` row for the admin listing — selects every column
 * EXCEPT the AES-GCM ciphertext (`access_enc`/`refresh_enc`) and the internal
 * `refresh_lock_at` singleflight stamp. Carries NO secret material.
 */
export interface OAuthSessionListRow {
  readonly secretRefId: string;
  readonly providerKind: string;
  readonly accountLabel: string | null;
  readonly accountId: string | null;
  readonly expiresAt: Date | null;
  readonly lastRefreshAt: Date | null;
  readonly status: string;
  readonly updatedAt: Date;
}

/**
 * List every registered `oauth_session` for the admin operator view, newest
 * first (`updated_at` DESC). Token-free by construction: the ciphertext columns
 * (`access_enc`/`refresh_enc`) and the internal `refresh_lock_at` are NOT
 * selected, so the tokens never leave the service via this path.
 */
export async function listOAuthSessions(db: DbOrTx): Promise<OAuthSessionListRow[]> {
  return db
    .select({
      secretRefId: oauthSession.secretRefId,
      providerKind: oauthSession.providerKind,
      accountLabel: oauthSession.accountLabel,
      accountId: oauthSession.accountId,
      expiresAt: oauthSession.expiresAt,
      lastRefreshAt: oauthSession.lastRefreshAt,
      status: oauthSession.status,
      updatedAt: oauthSession.updatedAt,
    })
    .from(oauthSession)
    .where(isNull(oauthSession.deletedAt))
    .orderBy(desc(oauthSession.updatedAt));
}

/**
 * List sessions the refresh sweep should attempt: `active`, with a known
 * `expires_at` due within `leadMs` (`expires_at <= now + lead`), and not
 * currently locked (`refresh_lock_at IS NULL` or a stale lock older than the
 * default staleness window). Returns raw rows; the worker decrypts the refresh
 * token itself (or via {@link getDecryptedOAuthSession}).
 */
export async function listRefreshableSessions(
  db: DbOrTx,
  now: Date,
  leadMs: number,
): Promise<OAuthSessionRow[]> {
  const dueBy = new Date(now.getTime() + leadMs);
  const staleBefore = new Date(now.getTime() - REFRESH_LOCK_STALE_MS);
  return db
    .select()
    .from(oauthSession)
    .where(
      and(
        eq(oauthSession.status, 'active'),
        isNull(oauthSession.deletedAt),
        isNotNull(oauthSession.expiresAt),
        lte(oauthSession.expiresAt, dueBy),
        or(isNull(oauthSession.refreshLockAt), lt(oauthSession.refreshLockAt, staleBefore)),
      ),
    );
}
