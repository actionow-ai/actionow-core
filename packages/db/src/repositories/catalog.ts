import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { account, modifier, secretRef } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

// 批次6 D3 (旧世界删除): the resource three-layer repo functions
// (resource / resource_version / upstream_channel / pricebook_entry) are
// deleted with their tables. This file keeps the SURVIVING assets that
// historically lived here: the secret vault (`secret_ref`), the pricing
// `modifier` CRUD, and `getAccountByTenant`.

export type SecretRefRow = InferSelectModel<typeof secretRef>;
export type ModifierRow = InferSelectModel<typeof modifier>;

/**
 * List EVERY active modifier, highest `priority` first (no scope filtering).
 *
 * Superseded on the run path by {@link listApplicableModifiers}, which restricts
 * the set to the scopes applicable to a specific `(tenant, resource)` run (§9.2).
 * Retained for callers/tests that intentionally want the unfiltered set.
 */
export async function listActiveModifiers(db: DbOrTx): Promise<ModifierRow[]> {
  return db
    .select()
    .from(modifier)
    .where(and(eq(modifier.active, true), isNull(modifier.deletedAt)))
    .orderBy(desc(modifier.priority));
}

/** The `(tenantId, resourceId)` a modifier scope is resolved against. */
export interface ModifierScopeTarget {
  readonly tenantId: string;
  readonly resourceId: string;
}

/**
 * The scope strings that apply to a given run (§9.2). A modifier fires only
 * when its `scope` column matches one of these exactly:
 * - `global` — applies to every run.
 * - `tenant:<tenantId>` — applies to all of one tenant's runs.
 * - `capability:<resourceId>` / `resource:<resourceId>` — applies to one
 *   resource. (Capability and resource are the same anchor首期; both spellings
 *   are accepted so a modifier authored against either matches.)
 */
export function applicableScopes(target: ModifierScopeTarget): string[] {
  return [
    'global',
    `tenant:${target.tenantId}`,
    `capability:${target.resourceId}`,
    `resource:${target.resourceId}`,
  ];
}

/**
 * List the active modifiers whose `scope` applies to a specific run (§9.2),
 * highest `priority` first. Replaces {@link listActiveModifiers} on the run
 * path: a modifier is returned only when it is `active` AND its `scope` is one
 * of {@link applicableScopes} for the run's `(tenantId, resourceId)`. The
 * `whenExpr`/coupon evaluation remains a domain concern applied downstream.
 */
export async function listApplicableModifiers(
  db: DbOrTx,
  target: ModifierScopeTarget,
): Promise<ModifierRow[]> {
  return db
    .select()
    .from(modifier)
    .where(
      and(
        eq(modifier.active, true),
        inArray(modifier.scope, applicableScopes(target)),
        isNull(modifier.deletedAt),
      ),
    )
    .orderBy(desc(modifier.priority));
}

/**
 * Resolve the single account for a tenant. Phase 3 assumes one account per
 * tenant (multi-account billing is a later phase). Returns `undefined` when the
 * tenant has no account.
 */
export async function getAccountByTenant(
  db: DbOrTx,
  tenantId: string,
): Promise<{ id: string; limitPlanId: string | null } | undefined> {
  const rows = await db
    .select({ id: account.id, limitPlanId: account.limitPlanId })
    .from(account)
    .where(and(eq(account.tenantId, tenantId), isNull(account.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Fetch a live `secret_ref` row by id (soft-deleted → `undefined`). */
export async function getSecretRef(db: DbOrTx, id: string): Promise<SecretRefRow | undefined> {
  const rows = await db
    .select()
    .from(secretRef)
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Metadata-only view of a `secret_ref` — id/provider/locator/timestamps. NEVER
 * carries the secret material: for `enc` secrets the AES-GCM ciphertext lives in
 * the separate `secret_material` table (not selected here), and `env`/`oauth`
 * locators reference a value resolved at run time. Used by the admin
 * list/get-by-id surface so the operator never sees a credential value.
 */
export interface SecretRefView {
  readonly id: string;
  readonly provider: string;
  readonly locator: string;
  /** Operator-editable metadata (catalog redesign). */
  readonly name: string | null;
  readonly notes: string | null;
  readonly groupTag: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The metadata columns selected for a {@link SecretRefView} (no material). */
const SECRET_REF_VIEW_COLUMNS = {
  id: secretRef.id,
  provider: secretRef.provider,
  locator: secretRef.locator,
  name: secretRef.name,
  notes: secretRef.notes,
  groupTag: secretRef.groupTag,
  createdAt: secretRef.createdAt,
  updatedAt: secretRef.updatedAt,
} as const;

/**
 * Alias for {@link getSecretRef} that returns the metadata-only {@link SecretRefView}
 * (no material) for the admin `GET /admin/secrets/:id` route. Soft-deleted →
 * `undefined`. The full {@link getSecretRef} row carries no material either (the
 * ciphertext lives in `secret_material`), so this is purely a typed projection.
 */
export async function getSecretRefById(db: DbOrTx, id: string): Promise<SecretRefView | undefined> {
  const rows = await db
    .select(SECRET_REF_VIEW_COLUMNS)
    .from(secretRef)
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * List live `secret_ref` rows (excludes soft-deleted), newest-first,
 * keyset-paginated on `(created_at, id)`. METADATA ONLY: the projection omits any
 * material — the `enc` ciphertext (in `secret_material`) is never joined — so the
 * secret value can never leave the service via this path.
 */
export async function listSecretRefs(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<SecretRefView>> {
  return keysetPage<SecretRefView>(db, {
    table: secretRef,
    createdAtCol: secretRef.createdAt,
    idCol: secretRef.id,
    selection: SECRET_REF_VIEW_COLUMNS,
    where: isNull(secretRef.deletedAt),
    page,
  });
}

/**
 * Revoke a `secret_ref` by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live. Resolution fails afterwards because
 * {@link getSecretRef} filters `deleted_at IS NULL` (the `enc`/`env` branches of
 * {@link resolveSecretRef} both deref through it); the 1:1 `secret_material`
 * ciphertext is intentionally LEFT in place (orphaned but unreachable). Returns
 * the deleted id, or `undefined` when nothing matched (not found / already
 * revoked) — a second revoke is a safe no-op, never a throw.
 */
export async function softDeleteSecretRef(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(secretRef)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .returning({ id: secretRef.id });
  return rows[0]?.id;
}

/**
 * Update a `secret_ref`'s operator metadata (name/notes/group_tag) only — never the
 * material. Returns the updated id, or `undefined` if not found / soft-deleted. Each
 * present key is set (including explicit `null` to clear).
 */
export async function updateSecretRefMeta(
  db: DbOrTx,
  id: string,
  meta: {
    readonly name?: string | null | undefined;
    readonly notes?: string | null | undefined;
    readonly group?: string | null | undefined;
  },
): Promise<SecretRefView | undefined> {
  const set: Partial<InferInsertModel<typeof secretRef>> = { updatedAt: new Date() };
  if (meta.name !== undefined) set.name = meta.name;
  if (meta.notes !== undefined) set.notes = meta.notes;
  if (meta.group !== undefined) set.groupTag = meta.group;
  const rows = await db
    .update(secretRef)
    .set(set)
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .returning(SECRET_REF_VIEW_COLUMNS);
  return rows[0];
}

/** Fields a caller supplies to {@link createSecretRef}. */
export interface CreateSecretRefInput {
  /** `env` | `vault` — where the secret is materialized from. */
  readonly provider: string;
  /** The locator within that provider (e.g. the env var name). */
  readonly locator: string;
  /** Optional human-readable name (operator metadata; shown in the credentials list). */
  readonly name?: string | null;
  /** Optional free-form notes (operator metadata). */
  readonly notes?: string | null;
  /** Optional grouping tag (operator metadata). */
  readonly groupTag?: string | null;
}

/**
 * Insert a `secret_ref` row (a credential locator, never the secret itself) and
 * return it. The resolver materializes the value at run time from `provider` +
 * `locator`; only the locator is persisted. Optional `name`/`notes`/`groupTag`
 * are operator-facing metadata (so a seeded credential isn't a blank row).
 */
export async function createSecretRef(
  db: DbOrTx,
  input: CreateSecretRefInput,
): Promise<SecretRefRow> {
  const rows = await db
    .insert(secretRef)
    .values({
      provider: input.provider,
      locator: input.locator,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.groupTag !== undefined ? { groupTag: input.groupTag } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSecretRef: insert returned no row');
  return row;
}

/** Fields a caller supplies to {@link createModifier}. */
export interface CreateModifierInput {
  /** `global` | `tenant:<id>` | `capability:<id>` | `resource:<id>` (§9.2). */
  readonly scope: string;
  readonly whenExpr?: string | null | undefined;
  /** `override_rate` | `percent_off` | `flat_off` | `percent_add`. */
  readonly op: string;
  /**
   * The modifier value. For `flat_off`/`override_rate` this is a µcredit amount
   * (the controller converts human credits via `creditsToMicro`); for the
   * percent ops it is a whole-percent integer.
   */
  readonly value?: bigint | null | undefined;
  readonly stackable?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly version?: number | undefined;
  readonly active?: boolean | undefined;
}

/** Insert a pricing `modifier` row. */
export async function createModifier(db: DbOrTx, input: CreateModifierInput): Promise<ModifierRow> {
  const rows = await db
    .insert(modifier)
    .values({
      scope: input.scope,
      whenExpr: input.whenExpr ?? null,
      op: input.op,
      value: input.value ?? null,
      stackable: input.stackable ?? true,
      priority: input.priority ?? 0,
      version: input.version ?? 1,
      active: input.active ?? true,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createModifier: insert returned no row');
  return row;
}

/**
 * List live modifiers (admin view, incl. inactive), keyset-paginated newest-first
 * on `(created_at, id)`.
 */
export async function listModifiers(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<ModifierRow>> {
  return keysetPage<ModifierRow>(db, {
    table: modifier,
    createdAtCol: modifier.createdAt,
    idCol: modifier.id,
    where: isNull(modifier.deletedAt),
    page,
  });
}

/** Fetch a live modifier by id (soft-deleted → `undefined`). */
export async function getModifierById(db: DbOrTx, id: string): Promise<ModifierRow | undefined> {
  const rows = await db
    .select()
    .from(modifier)
    .where(and(eq(modifier.id, id), isNull(modifier.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Mutable fields of a `modifier` (admin PATCH); omitted keys are unchanged. */
export interface UpdateModifierInput {
  readonly whenExpr?: string | null | undefined;
  readonly op?: string | undefined;
  /**
   * The modifier value: a µcredit amount for credit ops (`flat_off`/
   * `override_rate`), a whole-percent int for percent ops. The controller
   * applies `creditsToMicro` for credit ops before calling this repo.
   */
  readonly value?: bigint | null | undefined;
  readonly stackable?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly active?: boolean | undefined;
}

/**
 * Patch a live `modifier` (only the supplied fields), bumping `updated_at`,
 * returning the new row. The `value` is stored verbatim — credit-denominated ops
 * arrive already converted to µcredits by the controller (mirroring
 * {@link createModifier}). Soft-deleted / unknown → `undefined`; an empty patch
 * reads the current live row back.
 */
export async function updateModifier(
  db: DbOrTx,
  id: string,
  patch: UpdateModifierInput,
): Promise<ModifierRow | undefined> {
  const set: Partial<InferInsertModel<typeof modifier>> = {};
  if (patch.whenExpr !== undefined) set.whenExpr = patch.whenExpr;
  if (patch.op !== undefined) set.op = patch.op;
  if (patch.value !== undefined) set.value = patch.value;
  if (patch.stackable !== undefined) set.stackable = patch.stackable;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) {
    return getModifierById(db, id);
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(modifier)
    .set(set)
    .where(and(eq(modifier.id, id), isNull(modifier.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke a modifier by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live. `listActiveModifiers` /
 * `listApplicableModifiers` / `listModifiers` / `getModifierById` all filter
 * `deleted_at IS NULL`, so the modifier stops affecting pricing + drops from the
 * listing. Returns the deleted id, or `undefined` when nothing matched —
 * idempotent.
 */
export async function softDeleteModifier(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(modifier)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(modifier.id, id), isNull(modifier.deletedAt)))
    .returning({ id: modifier.id });
  return rows[0]?.id;
}
