import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { apiKey, user, userIdentity } from '../schema/index.js';
import type { DbOrTx } from './types.js';

/** Fields a caller supplies to {@link createApiKey}. */
export interface CreateApiKeyInput {
  readonly tenantId: string;
  /** Resources this key may run; an empty/omitted list means "no restriction". */
  readonly resourceAllowlist?: readonly string[] | undefined;
  /** Per-(tenant,resource) requests-per-minute cap; `null`/omitted → default. */
  readonly rateLimit?: number | undefined;
}

/** The created key's id plus its ONE-TIME plaintext (never re-derivable). */
export interface CreatedApiKey {
  readonly id: string;
  /** `ak_<base64url(32 random bytes)>`. Shown once; only its hash is stored. */
  readonly plaintext: string;
}

/** The verification view of an `api_key` row used by the auth guard. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly resourceAllowlist: string[];
  readonly rateLimit: number | null;
  readonly status: string;
}

/** Compute the stored lookup hash for an API key (sha256 hex of the plaintext). */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Mint a new API key for a tenant. The plaintext (`ak_<base64url(32 bytes)>`) is
 * generated from `node:crypto` randomness and returned ONCE; only its sha256 hex
 * `hash` is persisted, so the plaintext can never be recovered from the db.
 */
export async function createApiKey(db: DbOrTx, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const plaintext = `ak_${randomBytes(32).toString('base64url')}`;
  const hash = hashApiKey(plaintext);

  const rows = await db
    .insert(apiKey)
    .values({
      tenantId: input.tenantId,
      hash,
      resourceAllowlist: input.resourceAllowlist ? [...input.resourceAllowlist] : [],
      rateLimit: input.rateLimit ?? null,
    })
    .returning({ id: apiKey.id });

  const row = rows[0];
  if (!row) throw new Error('createApiKey: insert returned no row');
  return { id: row.id, plaintext };
}

/**
 * Look a LIVE API key up by its sha256 hex hash, or `undefined` when absent or
 * soft-deleted (revoked). The `deleted_at IS NULL` predicate means a revoked key
 * authenticates as absent — the auth guard sees no record and rejects (Track D).
 */
export async function findApiKeyByHash(
  db: DbOrTx,
  hash: string,
): Promise<ApiKeyRecord | undefined> {
  const rows = await db
    .select({
      id: apiKey.id,
      tenantId: apiKey.tenantId,
      resourceAllowlist: apiKey.resourceAllowlist,
      rateLimit: apiKey.rateLimit,
      status: apiKey.status,
    })
    .from(apiKey)
    .where(and(eq(apiKey.hash, hash), isNull(apiKey.deletedAt)))
    .limit(1);
  return rows[0];
}

/** The tenant-scoped view of an `api_key` row (no `hash`). */
export interface ApiKeyView {
  readonly id: string;
  readonly tenantId: string;
  readonly resourceAllowlist: string[];
  readonly rateLimit: number | null;
  readonly status: string;
  readonly createdAt: Date;
}

const API_KEY_VIEW_COLUMNS = {
  id: apiKey.id,
  tenantId: apiKey.tenantId,
  resourceAllowlist: apiKey.resourceAllowlist,
  rateLimit: apiKey.rateLimit,
  status: apiKey.status,
  createdAt: apiKey.createdAt,
} as const;

/**
 * Read one API key scoped to a tenant. The `tenant_id` predicate is in SQL, so a
 * key id that belongs to another tenant resolves to `undefined` (cross-tenant
 * safe). Excludes the `hash` — callers only ever see the one-time plaintext.
 */
export async function getApiKeyForTenant(
  db: DbOrTx,
  keyId: string,
  tenantId: string,
): Promise<ApiKeyView | undefined> {
  const rows = await db
    .select(API_KEY_VIEW_COLUMNS)
    .from(apiKey)
    .where(and(eq(apiKey.id, keyId), eq(apiKey.tenantId, tenantId), isNull(apiKey.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Flip a tenant's key to `status='disabled'` and bump `updated_at`. Tenant-
 * predicated in SQL, so a cross-tenant id updates no rows and returns `false`;
 * `true` on success. Skips already-soft-deleted rows.
 */
export async function disableApiKeyForTenant(
  db: DbOrTx,
  keyId: string,
  tenantId: string,
): Promise<boolean> {
  const rows = await db
    .update(apiKey)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(and(eq(apiKey.id, keyId), eq(apiKey.tenantId, tenantId), isNull(apiKey.deletedAt)))
    .returning({ id: apiKey.id });
  return rows.length === 1;
}

/**
 * Rotate a tenant's key in one transaction: mint a fresh plaintext that inherits
 * the old key's `resourceAllowlist`/`rateLimit`, then disable the old row. The
 * tenant predicate is in SQL — a cross-tenant id is a no-op returning `undefined`
 * (nothing is minted or disabled). The new {@link CreatedApiKey} plaintext is
 * shown ONCE.
 */
export async function rotateApiKeyForTenant(
  db: DbOrTx,
  keyId: string,
  tenantId: string,
): Promise<CreatedApiKey | undefined> {
  return db.transaction(async (tx) => {
    const existing = await getApiKeyForTenant(tx, keyId, tenantId);
    if (existing === undefined) return undefined;
    const created = await createApiKey(tx, {
      tenantId,
      resourceAllowlist: existing.resourceAllowlist,
      rateLimit: existing.rateLimit ?? undefined,
    });
    await disableApiKeyForTenant(tx, keyId, tenantId);
    return created;
  });
}

/** Normalize an email for storage/lookup: trim + lowercase (case-insensitive). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Fields a caller supplies to {@link createUser}. */
export interface CreateUserInput {
  readonly email: string;
  /**
   * A `scrypt$<salt>$<hash>` string (never a plaintext password). Omitted/`null`
   * for an OAuth-only account that has no local password.
   */
  readonly passwordHash?: string | null | undefined;
  /** `user` (default) or `admin`. */
  readonly role?: string | undefined;
  /** `active` (default) or e.g. `disabled`. */
  readonly status?: string | undefined;
  /** Whether the email is proven (default `false`); admins/seed pass `true`. */
  readonly emailVerified?: boolean | undefined;
  /** The tenant this user provisioned, if any. */
  readonly tenantId?: string | undefined;
}

/** The full user record needed to authenticate a login + issue a JWT. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** `null` for an OAuth-only account with no local password. */
  readonly passwordHash: string | null;
  readonly role: string;
  readonly status: string;
  readonly tenantId: string | null;
}

/** The columns selected for a {@link UserRecord}. */
const USER_COLUMNS = {
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified,
  passwordHash: user.passwordHash,
  role: user.role,
  status: user.status,
  tenantId: user.tenantId,
} as const;

/** Insert a `user` row (email stored lowercase-normalized) and return it. */
export async function createUser(db: DbOrTx, input: CreateUserInput): Promise<UserRecord> {
  const rows = await db
    .insert(user)
    .values({
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash ?? null,
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    })
    .returning(USER_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error('createUser: insert returned no row');
  return row;
}

/** Look a user up by email (case-insensitive — normalized), or `undefined`. */
export async function findUserByEmail(db: DbOrTx, email: string): Promise<UserRecord | undefined> {
  const rows = await db
    .select(USER_COLUMNS)
    .from(user)
    .where(eq(user.email, normalizeEmail(email)))
    .limit(1);
  return rows[0];
}

/** Look a user up by id, or `undefined` when absent. */
export async function findUserById(db: DbOrTx, id: string): Promise<UserRecord | undefined> {
  const rows = await db.select(USER_COLUMNS).from(user).where(eq(user.id, id)).limit(1);
  return rows[0];
}

/**
 * Resolve the user behind an external identity by `(provider, provider_user_id)`
 * — the provider's stable subject, never the email. Joins `user_identity` →
 * `user`. Returns `undefined` when no identity matches.
 */
export async function findUserByIdentity(
  db: DbOrTx,
  provider: string,
  providerUserId: string,
): Promise<UserRecord | undefined> {
  const rows = await db
    .select(USER_COLUMNS)
    .from(userIdentity)
    .innerJoin(user, eq(userIdentity.userId, user.id))
    .where(
      and(eq(userIdentity.provider, provider), eq(userIdentity.providerUserId, providerUserId)),
    )
    .limit(1);
  return rows[0];
}

/** Fields a caller supplies to {@link createUserIdentity}. */
export interface CreateUserIdentityInput {
  readonly userId: string;
  readonly provider: string;
  readonly providerUserId: string;
}

/**
 * Link an external identity to a user. The unique `(provider, provider_user_id)`
 * index makes a duplicate link throw — callers treat that as "already linked".
 */
export async function createUserIdentity(
  db: DbOrTx,
  input: CreateUserIdentityInput,
): Promise<{ id: string }> {
  const rows = await db
    .insert(userIdentity)
    .values({
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
    })
    .returning({ id: userIdentity.id });
  const row = rows[0];
  if (!row) throw new Error('createUserIdentity: insert returned no row');
  return { id: row.id };
}

/** Fields a caller supplies to {@link linkIdentityTx}. */
export interface LinkIdentityInput extends CreateUserInput {
  readonly provider: string;
  readonly providerUserId: string;
}

/**
 * Create a user AND its first external identity in a single transaction — the
 * find-or-create helper OAuth uses for a brand-new `(provider, sub)`. If either
 * insert fails (e.g. the unique identity index), the whole thing rolls back.
 */
export async function linkIdentityTx(db: DbOrTx, input: LinkIdentityInput): Promise<UserRecord> {
  const { provider, providerUserId, ...userInput } = input;
  return db.transaction(async (tx) => {
    const created = await createUser(tx, userInput);
    await createUserIdentity(tx, { userId: created.id, provider, providerUserId });
    return created;
  });
}
