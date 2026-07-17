import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { account, apiKey, ledgerTxn, tenant } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
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

/** List live tenants (excludes soft-deleted), newest-first, keyset-paginated. */
export async function listTenants(db: DbOrTx, page: PageParams): Promise<KeysetResult<TenantRow>> {
  return keysetPage<TenantRow>(db, {
    table: tenant,
    createdAtCol: tenant.createdAt,
    idCol: tenant.id,
    where: isNull(tenant.deletedAt),
    page,
  });
}

/** Count live tenants (excludes soft-deleted) — authoritative total for the ops summary. */
export async function countTenants(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(tenant)
    .where(isNull(tenant.deletedAt));
  return Number(rows[0]?.n ?? 0);
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

/** Mutable fields of a `tenant` (admin PATCH); omitted keys are unchanged. */
export interface UpdateTenantInput {
  /** `field` | `schema` | `db` (§8). */
  readonly isolationMode?: string | undefined;
}

/**
 * Patch a live `tenant` (only the supplied fields), bumping `updated_at`,
 * returning the new row. Limited to `isolation_mode` — the tenant name/id are not
 * mutated here. Soft-deleted / unknown → `undefined`; an empty patch reads the
 * current live row back. (There is intentionally NO tenant DELETE — too
 * destructive to cascade from an admin route.)
 */
export async function updateTenant(
  db: DbOrTx,
  tenantId: string,
  patch: UpdateTenantInput,
): Promise<TenantRow | undefined> {
  if (patch.isolationMode === undefined) {
    return getTenant(db, tenantId);
  }
  const rows = await db
    .update(tenant)
    .set({ isolationMode: patch.isolationMode, updatedAt: new Date() })
    .where(and(eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .returning();
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

/** List live accounts (excludes soft-deleted), newest-first, keyset-paginated. */
export async function listAccounts(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<AccountRow>> {
  return keysetPage<AccountRow>(db, {
    table: account,
    createdAtCol: account.createdAt,
    idCol: account.id,
    where: isNull(account.deletedAt),
    page,
  });
}

/** Count live accounts (excludes soft-deleted) — authoritative total for the ops summary. */
export async function countAccounts(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(account)
    .where(isNull(account.deletedAt));
  return Number(rows[0]?.n ?? 0);
}

/**
 * List a tenant's API keys (admin view). The stored `hash` is intentionally
 * NOT selected — the plaintext is unrecoverable and the hash is never surfaced.
 */
export async function listApiKeys(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
): Promise<KeysetResult<Omit<ApiKeyRow, 'hash'>>> {
  return keysetPage<Omit<ApiKeyRow, 'hash'>>(db, {
    table: apiKey,
    createdAtCol: apiKey.createdAt,
    idCol: apiKey.id,
    selection: {
      id: apiKey.id,
      tenantId: apiKey.tenantId,
      resourceAllowlist: apiKey.resourceAllowlist,
      modelAllowlist: apiKey.modelAllowlist,
      rateLimit: apiKey.rateLimit,
      status: apiKey.status,
      routeGroupId: apiKey.routeGroupId,
      limitPlanId: apiKey.limitPlanId,
      subjectId: apiKey.subjectId,
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.updatedAt,
      deletedAt: apiKey.deletedAt,
    },
    where: and(eq(apiKey.tenantId, tenantId), isNull(apiKey.deletedAt)),
    page,
  });
}

/**
 * List the LIVE api keys scoped to one subject (the end-user self-service view),
 * within its tenant. The `hash` is intentionally NOT selected (the plaintext is
 * unrecoverable and never surfaced), and the `(tenant, subject)` predicate keeps
 * a member from ever seeing another tenant's/subject's keys. Newest-first.
 */
export async function listApiKeysBySubject(
  db: DbOrTx,
  tenantId: string,
  subjectId: string,
): Promise<Omit<ApiKeyRow, 'hash'>[]> {
  return db
    .select({
      id: apiKey.id,
      tenantId: apiKey.tenantId,
      resourceAllowlist: apiKey.resourceAllowlist,
      modelAllowlist: apiKey.modelAllowlist,
      rateLimit: apiKey.rateLimit,
      status: apiKey.status,
      routeGroupId: apiKey.routeGroupId,
      limitPlanId: apiKey.limitPlanId,
      subjectId: apiKey.subjectId,
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.updatedAt,
      deletedAt: apiKey.deletedAt,
    })
    .from(apiKey)
    .where(
      and(eq(apiKey.tenantId, tenantId), eq(apiKey.subjectId, subjectId), isNull(apiKey.deletedAt)),
    )
    .orderBy(sql`${apiKey.createdAt} DESC`);
}

/**
 * List a tenant's ledger transactions newest-first, keyset-paginated on
 * `(created_at, id)`. The `tenant_id` filter composes with the keyset.
 */
export async function listLedger(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
): Promise<KeysetResult<LedgerRow>> {
  return keysetPage<LedgerRow>(db, {
    table: ledgerTxn,
    createdAtCol: ledgerTxn.createdAt,
    idCol: ledgerTxn.id,
    where: eq(ledgerTxn.tenantId, tenantId),
    page,
  });
}
