import type { InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';

import { account, apiKey, ledgerTxn, tenant } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type TenantRow = InferSelectModel<typeof tenant>;
export type AccountRow = InferSelectModel<typeof account>;
export type ApiKeyRow = InferSelectModel<typeof apiKey>;
export type LedgerRow = InferSelectModel<typeof ledgerTxn>;

/** Fields a caller supplies to {@link createTenant}. */
export interface CreateTenantInput {
  readonly name: string;
  /** `field` | `schema` | `db` (§8). Defaults to `field` (db default). */
  readonly isolationMode?: string | undefined;
}

/** Insert a `tenant` row and return it. */
export async function createTenant(db: DbOrTx, input: CreateTenantInput): Promise<TenantRow> {
  const rows = await db
    .insert(tenant)
    .values({
      name: input.name,
      ...(input.isolationMode !== undefined ? { isolationMode: input.isolationMode } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createTenant: insert returned no row');
  return row;
}

/** List all live tenants (excludes soft-deleted), newest-first. */
export async function listTenants(db: DbOrTx): Promise<TenantRow[]> {
  return db.select().from(tenant).where(isNull(tenant.deletedAt)).orderBy(desc(tenant.createdAt));
}

/** Fetch a live tenant by id (soft-deleted → `undefined`). */
export async function getTenant(db: DbOrTx, tenantId: string): Promise<TenantRow | undefined> {
  const rows = await db
    .select()
    .from(tenant)
    .where(and(eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Fields a caller supplies to {@link createAccount}. */
export interface CreateAccountInput {
  readonly tenantId: string;
  /** Opening balance in µcredits (controller converts human credits). */
  readonly creditBalance?: bigint | undefined;
}

/** Insert an `account` row for a tenant and return it. */
export async function createAccount(db: DbOrTx, input: CreateAccountInput): Promise<AccountRow> {
  const rows = await db
    .insert(account)
    .values({
      tenantId: input.tenantId,
      ...(input.creditBalance !== undefined ? { creditBalance: input.creditBalance } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createAccount: insert returned no row');
  return row;
}

/** Fetch a live account by id (soft-deleted → `undefined`). */
export async function getAccount(db: DbOrTx, accountId: string): Promise<AccountRow | undefined> {
  const rows = await db
    .select()
    .from(account)
    .where(and(eq(account.id, accountId), isNull(account.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * List a tenant's API keys (admin view). The stored `hash` is intentionally
 * NOT selected — the plaintext is unrecoverable and the hash is never surfaced.
 */
export async function listApiKeys(
  db: DbOrTx,
  tenantId: string,
): Promise<Omit<ApiKeyRow, 'hash'>[]> {
  return db
    .select({
      id: apiKey.id,
      tenantId: apiKey.tenantId,
      resourceAllowlist: apiKey.resourceAllowlist,
      rateLimit: apiKey.rateLimit,
      status: apiKey.status,
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.updatedAt,
      deletedAt: apiKey.deletedAt,
    })
    .from(apiKey)
    .where(and(eq(apiKey.tenantId, tenantId), isNull(apiKey.deletedAt)))
    .orderBy(desc(apiKey.createdAt));
}

/**
 * List a tenant's ledger transactions newest-first, keyset-paginated. `cursor`
 * is an exclusive upper bound on `created_at` (ISO string); `limit` caps the
 * page size.
 */
export async function listLedger(
  db: DbOrTx,
  tenantId: string,
  cursor?: string,
  limit = 50,
): Promise<LedgerRow[]> {
  const where =
    cursor === undefined
      ? eq(ledgerTxn.tenantId, tenantId)
      : and(eq(ledgerTxn.tenantId, tenantId), lt(ledgerTxn.createdAt, new Date(cursor)));
  return db.select().from(ledgerTxn).where(where).orderBy(desc(ledgerTxn.createdAt)).limit(limit);
}
