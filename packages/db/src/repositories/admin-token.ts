import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { adminToken } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

/** Compute the stored lookup hash for an admin service token (sha256 hex). */
export function hashAdminToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Fields a caller supplies to {@link createAdminToken}. */
export interface CreateAdminTokenInput {
  /** Human label identifying the integration this token is for. */
  readonly name: string;
  /** The admin (`user.id`) minting the token — audit attribution. */
  readonly createdBy: string;
  /** Optional expiry; omitted/`null` → never expires. */
  readonly expiresAt?: Date | undefined;
}

/** The created token's id plus its ONE-TIME plaintext (never re-derivable). */
export interface CreatedAdminToken {
  readonly id: string;
  /** `at_<base64url(32 random bytes)>`. Shown once; only its hash is stored. */
  readonly plaintext: string;
}

/** The verification view of an `admin_token` row used by the admin guard. */
export interface AdminTokenRecord {
  readonly id: string;
  /** The admin who minted it; the guard attaches this as the request's `adminId`. */
  readonly createdBy: string;
  readonly status: string;
  /** `null` → never expires; otherwise the guard rejects once past it. */
  readonly expiresAt: Date | null;
}

/** The operator-facing view of an `admin_token` row (NEVER includes `hash`). */
export interface AdminTokenView {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mint a new admin service token. The plaintext (`at_<base64url(32 bytes)>`) is
 * generated from `node:crypto` randomness and returned ONCE; only its sha256 hex
 * `hash` is persisted, so the plaintext can never be recovered from the db. The
 * `at_` prefix distinguishes it from a data-plane `ak_` api key.
 */
export async function createAdminToken(
  db: DbOrTx,
  input: CreateAdminTokenInput,
): Promise<CreatedAdminToken> {
  const plaintext = `at_${randomBytes(32).toString('base64url')}`;
  const hash = hashAdminToken(plaintext);

  const rows = await db
    .insert(adminToken)
    .values({
      name: input.name,
      hash,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: adminToken.id });

  const row = rows[0];
  if (!row) throw new Error('createAdminToken: insert returned no row');
  return { id: row.id, plaintext };
}

/**
 * Look a LIVE admin token up by its sha256 hex hash, or `undefined` when absent or
 * soft-deleted (revoked). Mirrors {@link findApiKeyByHash}: the `deleted_at IS NULL`
 * predicate makes a revoked token authenticate as absent. The returned record
 * carries `status` and `expiresAt` so the GUARD decides active/expired (it does
 * not filter those here, to keep the rejection reason uniform).
 */
export async function findAdminTokenByHash(
  db: DbOrTx,
  hash: string,
): Promise<AdminTokenRecord | undefined> {
  const rows = await db
    .select({
      id: adminToken.id,
      createdBy: adminToken.createdBy,
      status: adminToken.status,
      expiresAt: adminToken.expiresAt,
    })
    .from(adminToken)
    .where(and(eq(adminToken.hash, hash), isNull(adminToken.deletedAt)))
    .limit(1);
  return rows[0];
}

const ADMIN_TOKEN_VIEW_COLUMNS = {
  id: adminToken.id,
  name: adminToken.name,
  createdBy: adminToken.createdBy,
  status: adminToken.status,
  expiresAt: adminToken.expiresAt,
  createdAt: adminToken.createdAt,
  updatedAt: adminToken.updatedAt,
} as const;

/**
 * List live admin tokens, newest-first, keyset-paginated. Excludes soft-deleted
 * (revoked) rows and NEVER selects the `hash` — operators only ever see metadata.
 */
export async function listAdminTokens(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<AdminTokenView>> {
  return keysetPage<AdminTokenView>(db, {
    table: adminToken,
    createdAtCol: adminToken.createdAt,
    idCol: adminToken.id,
    selection: ADMIN_TOKEN_VIEW_COLUMNS,
    where: isNull(adminToken.deletedAt),
    page,
  });
}

/**
 * Revoke an admin token by SOFT-DELETING it (stamps `deleted_at`/`updated_at` only
 * when still live). A revoked token authenticates as absent — {@link findAdminTokenByHash}
 * filters `deleted_at IS NULL`. Returns the deleted token's `id`, or `undefined`
 * when nothing matched (not found / already revoked) — a second revoke is a safe
 * no-op, never a throw.
 */
export async function softDeleteAdminToken(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(adminToken)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(adminToken.id, id), isNull(adminToken.deletedAt)))
    .returning({ id: adminToken.id });
  return rows[0]?.id;
}
