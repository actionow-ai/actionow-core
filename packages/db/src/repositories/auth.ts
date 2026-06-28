import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { apiKey, subject, user, userIdentity } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

/** Fields a caller supplies to {@link createApiKey}. */
export interface CreateApiKeyInput {
  readonly tenantId: string;
  /** Resources this key may run; an empty/omitted list means "no restriction". */
  readonly resourceAllowlist?: readonly string[] | undefined;
  /** Per-(tenant,resource) requests-per-minute cap; `null`/omitted → default. */
  readonly rateLimit?: number | undefined;
  /** The subject (end-user) this key is scoped to (unified tenancy G-B); null → tenant-level. */
  readonly subjectId?: string | null | undefined;
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
  /** The bound route group (Track 3); `null` → the `default` group at routing time. */
  readonly routeGroupId: string | null;
  /** The bound limit plan (额度套餐; governance-limits); `null` → no per-key limits. */
  readonly limitPlanId: string | null;
  /** The subject (end-user) this key is scoped to (unified tenancy G-B); `null` → tenant-level. */
  readonly subjectId: string | null;
  /**
   * Whether the bound subject is usable: `null` for a tenant-level key (no
   * subject); otherwise `true` iff the subject row is live + `status='active'`.
   * The guard rejects a subject-scoped key whose subject is `false`.
   */
  readonly subjectActive: boolean | null;
  /** The subject's bound limit plan (额度套餐); `null` → none / tenant-level key. */
  readonly subjectLimitPlanId: string | null;
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
      subjectId: input.subjectId ?? null,
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
  // LEFT JOIN the subject so a subject-scoped key resolves its subject's
  // liveness + bound plan in one round-trip; a tenant-level key (subject_id
  // NULL) joins to no row and reports subjectActive=null.
  const rows = await db
    .select({
      id: apiKey.id,
      tenantId: apiKey.tenantId,
      resourceAllowlist: apiKey.resourceAllowlist,
      rateLimit: apiKey.rateLimit,
      status: apiKey.status,
      routeGroupId: apiKey.routeGroupId,
      limitPlanId: apiKey.limitPlanId,
      subjectId: apiKey.subjectId,
      subjectStatus: subject.status,
      subjectDeletedAt: subject.deletedAt,
      subjectLimitPlanId: subject.limitPlanId,
    })
    .from(apiKey)
    .leftJoin(subject, eq(subject.id, apiKey.subjectId))
    .where(and(eq(apiKey.hash, hash), isNull(apiKey.deletedAt)))
    .limit(1);
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    tenantId: r.tenantId,
    resourceAllowlist: r.resourceAllowlist,
    rateLimit: r.rateLimit,
    status: r.status,
    routeGroupId: r.routeGroupId,
    limitPlanId: r.limitPlanId,
    subjectId: r.subjectId,
    subjectActive:
      r.subjectId === null ? null : r.subjectStatus === 'active' && r.subjectDeletedAt === null,
    subjectLimitPlanId: r.subjectLimitPlanId ?? null,
  };
}

/** The tenant-scoped view of an `api_key` row (no `hash`). */
export interface ApiKeyView {
  readonly id: string;
  readonly tenantId: string;
  readonly resourceAllowlist: string[];
  readonly rateLimit: number | null;
  readonly status: string;
  /** The bound route group (Track 3); `null` → the `default` group at routing time. */
  readonly routeGroupId: string | null;
  /** The subject (end-user) this key is scoped to (unified tenancy G-B); `null` → tenant-level. */
  readonly subjectId: string | null;
  readonly createdAt: Date;
}

const API_KEY_VIEW_COLUMNS = {
  id: apiKey.id,
  tenantId: apiKey.tenantId,
  resourceAllowlist: apiKey.resourceAllowlist,
  rateLimit: apiKey.rateLimit,
  status: apiKey.status,
  routeGroupId: apiKey.routeGroupId,
  subjectId: apiKey.subjectId,
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
 * Revoke an API key by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live. A revoked key authenticates as
 * absent — {@link findApiKeyByHash} filters `deleted_at IS NULL`, so the auth
 * guard sees no record and rejects with 401 (Track D revoke).
 *
 * `tenantId` is OPTIONAL: when supplied the delete is tenant-predicated in SQL
 * (a cross-tenant id matches no row), matching the tenant-scoped read repos
 * (`getApiKeyForTenant`/`disableApiKeyForTenant`); when omitted the admin
 * operator revokes by `:id` across tenants. Returns the deleted key's `id`, or
 * `undefined` when nothing matched (not found / already revoked / wrong tenant)
 * — a second revoke is a safe no-op, never a throw.
 */
export async function softDeleteApiKey(
  db: DbOrTx,
  keyId: string,
  tenantId?: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(apiKey)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(apiKey.id, keyId),
        ...(tenantId !== undefined ? [eq(apiKey.tenantId, tenantId)] : []),
        isNull(apiKey.deletedAt),
      ),
    )
    .returning({ id: apiKey.id });
  return rows[0]?.id;
}

/**
 * Revoke a SUBJECT-SCOPED api key by SOFT-DELETING it (member self-service). The
 * predicate is `(id, tenant_id, subject_id)` in SQL, so a member can only ever
 * revoke its OWN key: another subject's key, a tenant-level key (`subject_id`
 * NULL), or a cross-tenant id all match no row and return `undefined` — never a
 * successful revoke. A revoked key authenticates as absent
 * ({@link findApiKeyByHash} filters `deleted_at IS NULL`). Returns the deleted
 * key's `id`, or `undefined` when nothing matched (idempotent; a second revoke is
 * a safe no-op).
 */
export async function softDeleteApiKeyForSubject(
  db: DbOrTx,
  keyId: string,
  tenantId: string,
  subjectId: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(apiKey)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(apiKey.id, keyId),
        eq(apiKey.tenantId, tenantId),
        eq(apiKey.subjectId, subjectId),
        isNull(apiKey.deletedAt),
      ),
    )
    .returning({ id: apiKey.id });
  return rows[0]?.id;
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
      subjectId: existing.subjectId,
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
  /**
   * Tenant-org seat level (RBAC v1): `admin` | `member`. Required for a
   * `role='user'` row by the DB CHECK (must be NULL for a `role='admin'` row).
   * Omitted → the column default (NULL) — only valid alongside `role='admin'`.
   */
  readonly tenantRole?: string | undefined;
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
  /**
   * Tenant-org seat level (RBAC v1): `admin` | `member` for a tenant operator
   * (`role='user'`); `null` for a system admin (`role='admin'`). Resolved here
   * for the ConsoleGuard — never signed into the JWT.
   */
  readonly tenantRole: string | null;
  readonly status: string;
  readonly tenantId: string | null;
  /** Row creation timestamp (surfaced for the tenant-users list view). */
  readonly createdAt: Date;
}

/** The columns selected for a {@link UserRecord}. */
const USER_COLUMNS = {
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified,
  passwordHash: user.passwordHash,
  role: user.role,
  tenantRole: user.tenantRole,
  status: user.status,
  tenantId: user.tenantId,
  createdAt: user.createdAt,
} as const;

/** Insert a `user` row (email stored lowercase-normalized) and return it. */
export async function createUser(db: DbOrTx, input: CreateUserInput): Promise<UserRecord> {
  const rows = await db
    .insert(user)
    .values({
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash ?? null,
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.tenantRole !== undefined ? { tenantRole: input.tenantRole } : {}),
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

/** Set a user's password hash (self-serve change-password). Returns the updated row, or undefined if the id is unknown. */
export async function updateUserPassword(
  db: DbOrTx,
  id: string,
  passwordHash: string,
): Promise<UserRecord | undefined> {
  const rows = await db
    .update(user)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(user.id, id))
    .returning(USER_COLUMNS);
  return rows[0];
}

/** Create a sub-user under an EXISTING tenant (role=user, tenant_role=member). Never creates a tenant. */
export async function createSubUser(
  db: DbOrTx,
  input: { tenantId: string; email: string; passwordHash: string },
): Promise<UserRecord> {
  return createUser(db, {
    email: input.email,
    passwordHash: input.passwordHash,
    role: 'user',
    tenantRole: 'member',
    tenantId: input.tenantId,
    emailVerified: true,
  });
}

/** List a tenant's operator users (keyset, newest-first). */
export function listUsersByTenant(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
): Promise<KeysetResult<UserRecord>> {
  return keysetPage<UserRecord>(db, {
    table: user,
    createdAtCol: user.createdAt,
    idCol: user.id,
    selection: USER_COLUMNS,
    where: eq(user.tenantId, tenantId),
    page,
  });
}

/** Set a tenant user's status (tenant-scoped); undefined when no row matched. */
export async function updateUserStatus(
  db: DbOrTx,
  tenantId: string,
  id: string,
  status: string,
): Promise<UserRecord | undefined> {
  const rows = await db
    .update(user)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(user.id, id), eq(user.tenantId, tenantId), eq(user.role, 'user')))
    .returning(USER_COLUMNS);
  return rows[0];
}

/** Promote/demote a tenant user (tenant-scoped); undefined when no row matched. */
export async function updateUserTenantRole(
  db: DbOrTx,
  tenantId: string,
  id: string,
  tenantRole: 'admin' | 'member',
): Promise<UserRecord | undefined> {
  const rows = await db
    .update(user)
    .set({ tenantRole, updatedAt: new Date() })
    .where(and(eq(user.id, id), eq(user.tenantId, tenantId), eq(user.role, 'user')))
    .returning(USER_COLUMNS);
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
