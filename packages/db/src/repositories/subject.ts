import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { subject, subjectIdentity, tenant, userIdentity } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

/** A `subject` (end-user) row. */
export type SubjectRow = InferSelectModel<typeof subject>;

/** Emails are stored lowercase-normalized (the per-tenant unique index is on the raw value). */
const normalizeEmail = (e: string): string => e.trim().toLowerCase();

/** Fields a caller supplies to {@link createSubject}. `external_id` is immutable after this (decision #6). */
export interface CreateSubjectInput {
  readonly tenantId: string;
  /** Model-B app-owned handle; omit/null for a pure Model-A subject. */
  readonly externalId?: string | null | undefined;
  /** Model-A login email (lowercased); omit/null for a pure Model-B subject. */
  readonly email?: string | null | undefined;
  readonly passwordHash?: string | null | undefined;
  readonly displayName?: string | null | undefined;
  readonly limitPlanId?: string | null | undefined;
  readonly status?: string | undefined;
}

/** Insert a subject (status defaults to `active`). Throws on a per-tenant external_id/email clash. */
export async function createSubject(db: DbOrTx, input: CreateSubjectInput): Promise<SubjectRow> {
  const rows = await db
    .insert(subject)
    .values({
      tenantId: input.tenantId,
      externalId: input.externalId ?? null,
      email: input.email != null ? normalizeEmail(input.email) : null,
      passwordHash: input.passwordHash ?? null,
      displayName: input.displayName ?? null,
      limitPlanId: input.limitPlanId ?? null,
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSubject: insert returned no row');
  return row;
}

/** A live subject by id, tenant-scoped (undefined when absent/deleted/other-tenant). */
export async function getSubjectById(
  db: DbOrTx,
  tenantId: string,
  id: string,
): Promise<SubjectRow | undefined> {
  const rows = await db
    .select()
    .from(subject)
    .where(and(eq(subject.id, id), eq(subject.tenantId, tenantId), isNull(subject.deletedAt)))
    .limit(1);
  return rows[0];
}

/** A live subject by its Model-B `external_id`, tenant-scoped. */
export async function findSubjectByExternalId(
  db: DbOrTx,
  tenantId: string,
  externalId: string,
): Promise<SubjectRow | undefined> {
  const rows = await db
    .select()
    .from(subject)
    .where(
      and(
        eq(subject.tenantId, tenantId),
        eq(subject.externalId, externalId),
        isNull(subject.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/** A live subject by its Model-A login `email` (normalized), tenant-scoped. */
export async function findSubjectByEmail(
  db: DbOrTx,
  tenantId: string,
  email: string,
): Promise<SubjectRow | undefined> {
  const rows = await db
    .select()
    .from(subject)
    .where(
      and(
        eq(subject.tenantId, tenantId),
        eq(subject.email, normalizeEmail(email)),
        isNull(subject.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/** A tenant's live subjects, newest-first, keyset-paginated on `(created_at, id)`. */
export function listSubjectsByTenant(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
): Promise<KeysetResult<SubjectRow>> {
  return keysetPage<SubjectRow>(db, {
    table: subject,
    createdAtCol: subject.createdAt,
    idCol: subject.id,
    where: and(eq(subject.tenantId, tenantId), isNull(subject.deletedAt)),
    page,
  });
}

/** Mutable subject fields; `external_id` is intentionally absent (immutable, decision #6). */
export interface UpdateSubjectInput {
  readonly email?: string | null | undefined;
  readonly passwordHash?: string | null | undefined;
  readonly displayName?: string | null | undefined;
  readonly limitPlanId?: string | null | undefined;
  readonly status?: string | undefined;
}

/** Patch a live subject (tenant-scoped); returns the new row, or undefined when absent. */
export async function updateSubject(
  db: DbOrTx,
  tenantId: string,
  id: string,
  patch: UpdateSubjectInput,
): Promise<SubjectRow | undefined> {
  const set: Partial<SubjectRow> = {};
  if (patch.email !== undefined)
    set.email = patch.email != null ? normalizeEmail(patch.email) : null;
  if (patch.passwordHash !== undefined) set.passwordHash = patch.passwordHash;
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.limitPlanId !== undefined) set.limitPlanId = patch.limitPlanId;
  if (patch.status !== undefined) set.status = patch.status;
  if (Object.keys(set).length === 0) return getSubjectById(db, tenantId, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(subject)
    .set(set)
    .where(and(eq(subject.id, id), eq(subject.tenantId, tenantId), isNull(subject.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Soft-delete a live subject: set `deleted_at` + `status='disabled'` (frees its
 * per-tenant external_id/email). Returns the id, or undefined (idempotent).
 * The full cascade (disable subject-scoped keys, sweep residual sub-wallet to
 * the tenant pool) lands in G-E once those tables exist.
 */
export async function softDeleteSubject(
  db: DbOrTx,
  tenantId: string,
  id: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(subject)
    .set({ deletedAt: now, status: 'disabled', updatedAt: now })
    .where(and(eq(subject.id, id), eq(subject.tenantId, tenantId), isNull(subject.deletedAt)))
    .returning({ id: subject.id });
  return rows[0]?.id;
}

/**
 * Model-B resolution (unified tenancy G-C): map an app-owned `external_id` to a
 * subject. Returns the existing live subject; if none and the tenant has opted
 * into JIT provisioning (`tenant.config.jit_provisioning_enabled === true`),
 * creates one; otherwise returns `null` so the caller fails the request with
 * `invalid_input` (never silently skips a paying end-user — decision #1).
 */
export async function resolveOrCreateSubject(
  db: DbOrTx,
  tenantId: string,
  externalId: string,
): Promise<SubjectRow | null> {
  const existing = await findSubjectByExternalId(db, tenantId, externalId);
  if (existing !== undefined) return existing;

  const rows = await db
    .select({ config: tenant.config })
    .from(tenant)
    .where(and(eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .limit(1);
  const jit = rows[0]?.config.jit_provisioning_enabled === true;
  if (!jit) return null;

  return createSubject(db, { tenantId, externalId });
}

// ── identity layer (federation + user↔subject; unified tenancy G-F, M-Y) ─────

/** Fields a caller supplies to {@link createSubjectIdentity}. */
export interface SubjectIdentityInput {
  readonly subjectId: string;
  readonly provider: string;
  readonly providerUserId: string;
}

/** Link a subject to an external provider identity (cross-tenant federation key). */
export async function createSubjectIdentity(
  db: DbOrTx,
  input: SubjectIdentityInput,
): Promise<{ id: string }> {
  const rows = await db
    .insert(subjectIdentity)
    .values({
      subjectId: input.subjectId,
      provider: input.provider,
      providerUserId: input.providerUserId,
    })
    .returning({ id: subjectIdentity.id });
  const row = rows[0];
  if (!row) throw new Error('createSubjectIdentity: insert returned no row');
  return { id: row.id };
}

/**
 * All LIVE subjects federated under one provider identity — the cross-tenant
 * "same human" set (resolve-only; never merges money/permissions). Empty when
 * no subject is linked to `(provider, provider_user_id)`.
 */
export async function findSubjectsByIdentity(
  db: DbOrTx,
  provider: string,
  providerUserId: string,
): Promise<SubjectRow[]> {
  const links = await db
    .select({ subjectId: subjectIdentity.subjectId })
    .from(subjectIdentity)
    .where(
      and(
        eq(subjectIdentity.provider, provider),
        eq(subjectIdentity.providerUserId, providerUserId),
      ),
    );
  const ids = links.map((l) => l.subjectId);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(subject)
    .where(and(inArray(subject.id, ids), isNull(subject.deletedAt)));
}

/**
 * Resolve the unified "person" behind a provider identity: the federated
 * subjects (across tenants) PLUS the operator `user.id` that shares the same
 * `(provider, provider_user_id)` (the user↔subject link), or `null`. The two
 * principals stay separate — this is a resolution overlay, not a merge.
 */
export async function resolveIdentityLink(
  db: DbOrTx,
  provider: string,
  providerUserId: string,
): Promise<{ subjects: SubjectRow[]; userId: string | null }> {
  const subjects = await findSubjectsByIdentity(db, provider, providerUserId);
  const u = await db
    .select({ id: userIdentity.userId })
    .from(userIdentity)
    .where(
      and(eq(userIdentity.provider, provider), eq(userIdentity.providerUserId, providerUserId)),
    )
    .limit(1);
  return { subjects, userId: u[0]?.id ?? null };
}
