import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { adminUser, apiKey } from '../schema/index.js';
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

/** Look an API key up by its sha256 hex hash, or `undefined` when absent. */
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
    .where(eq(apiKey.hash, hash))
    .limit(1);
  return rows[0];
}

/** Fields a caller supplies to {@link createAdminUser}. */
export interface CreateAdminUserInput {
  readonly email: string;
  /** A `scrypt$<salt>$<hash>` string (never a plaintext password). */
  readonly passwordHash: string;
  readonly role: string;
}

/** The admin record needed to authenticate a login + issue a JWT. */
export interface AdminUserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly status: string;
}

/** Insert an `admin_user` row and return its id. */
export async function createAdminUser(
  db: DbOrTx,
  input: CreateAdminUserInput,
): Promise<{ id: string }> {
  const rows = await db
    .insert(adminUser)
    .values({ email: input.email, passwordHash: input.passwordHash, role: input.role })
    .returning({ id: adminUser.id });
  const row = rows[0];
  if (!row) throw new Error('createAdminUser: insert returned no row');
  return { id: row.id };
}

/** Look an admin up by email (case-sensitive), or `undefined` when absent. */
export async function findAdminByEmail(
  db: DbOrTx,
  email: string,
): Promise<AdminUserRecord | undefined> {
  const rows = await db
    .select({
      id: adminUser.id,
      email: adminUser.email,
      passwordHash: adminUser.passwordHash,
      role: adminUser.role,
      status: adminUser.status,
    })
    .from(adminUser)
    .where(eq(adminUser.email, email))
    .limit(1);
  return rows[0];
}
