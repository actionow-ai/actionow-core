import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { faultPolicy } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type FaultPolicyRow = InferSelectModel<typeof faultPolicy>;

/** Fields a caller supplies to {@link createFaultPolicy}; unset → schema default. */
export interface CreateFaultPolicyInput {
  readonly name: string;
  readonly fastFail?: boolean | undefined;
  readonly retryCount?: number | undefined;
  readonly backoffType?: string | undefined;
  readonly backoffMs?: number | undefined;
  readonly connectTimeoutMs?: number | null | undefined;
  readonly ttftTimeoutMs?: number | null | undefined;
  readonly totalTimeoutMs?: number | null | undefined;
  readonly idleTimeoutMs?: number | null | undefined;
  readonly retryCodes?: number[] | null | undefined;
  readonly retryMessages?: string[] | null | undefined;
  readonly status?: string | undefined;
  readonly description?: string | null | undefined;
}

/** Insert a `fault_policy` row and return it. */
export async function createFaultPolicy(
  db: DbOrTx,
  input: CreateFaultPolicyInput,
): Promise<FaultPolicyRow> {
  const rows = await db
    .insert(faultPolicy)
    .values({
      name: input.name,
      ...(input.fastFail !== undefined ? { fastFail: input.fastFail } : {}),
      ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
      ...(input.backoffType !== undefined ? { backoffType: input.backoffType } : {}),
      ...(input.backoffMs !== undefined ? { backoffMs: input.backoffMs } : {}),
      ...(input.connectTimeoutMs !== undefined ? { connectTimeoutMs: input.connectTimeoutMs } : {}),
      ...(input.ttftTimeoutMs !== undefined ? { ttftTimeoutMs: input.ttftTimeoutMs } : {}),
      ...(input.totalTimeoutMs !== undefined ? { totalTimeoutMs: input.totalTimeoutMs } : {}),
      ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
      ...(input.retryCodes !== undefined ? { retryCodes: input.retryCodes } : {}),
      ...(input.retryMessages !== undefined ? { retryMessages: input.retryMessages } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createFaultPolicy: insert returned no row');
  return row;
}

/** List live fault policies (excludes soft-deleted), newest-first, keyset-paginated. */
export function listFaultPolicies(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<FaultPolicyRow>> {
  return keysetPage<FaultPolicyRow>(db, {
    table: faultPolicy,
    createdAtCol: faultPolicy.createdAt,
    idCol: faultPolicy.id,
    where: isNull(faultPolicy.deletedAt),
    page,
  });
}

/** Fetch a live fault policy by id (soft-deleted → `undefined`). */
export async function getFaultPolicyById(
  db: DbOrTx,
  id: string,
): Promise<FaultPolicyRow | undefined> {
  const rows = await db
    .select()
    .from(faultPolicy)
    .where(and(eq(faultPolicy.id, id), isNull(faultPolicy.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Batch-fetch live fault policies by id → a `Map<id, row>` (soft-deleted/unknown
 * ids absent). Used by the router to resolve policies for a candidate channel set
 * without an N+1 per-channel query.
 */
export async function getFaultPoliciesByIds(
  db: DbOrTx,
  ids: readonly string[],
): Promise<Map<string, FaultPolicyRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select()
    .from(faultPolicy)
    .where(and(inArray(faultPolicy.id, unique), isNull(faultPolicy.deletedAt)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Mutable fields of a {@link faultPolicy} (admin PATCH); omitted keys are unchanged. */
export interface UpdateFaultPolicyInput {
  readonly name?: string | undefined;
  readonly fastFail?: boolean | undefined;
  readonly retryCount?: number | undefined;
  readonly backoffType?: string | undefined;
  readonly backoffMs?: number | undefined;
  readonly connectTimeoutMs?: number | null | undefined;
  readonly ttftTimeoutMs?: number | null | undefined;
  readonly totalTimeoutMs?: number | null | undefined;
  readonly idleTimeoutMs?: number | null | undefined;
  readonly retryCodes?: number[] | null | undefined;
  readonly retryMessages?: string[] | null | undefined;
  readonly status?: string | undefined;
  readonly description?: string | null | undefined;
}

/** Patch a live fault policy (by id); only supplied fields change. An empty patch reads it back. */
export async function updateFaultPolicy(
  db: DbOrTx,
  id: string,
  patch: UpdateFaultPolicyInput,
): Promise<FaultPolicyRow | undefined> {
  const set: Partial<InferInsertModel<typeof faultPolicy>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.fastFail !== undefined) set.fastFail = patch.fastFail;
  if (patch.retryCount !== undefined) set.retryCount = patch.retryCount;
  if (patch.backoffType !== undefined) set.backoffType = patch.backoffType;
  if (patch.backoffMs !== undefined) set.backoffMs = patch.backoffMs;
  if (patch.connectTimeoutMs !== undefined) set.connectTimeoutMs = patch.connectTimeoutMs;
  if (patch.ttftTimeoutMs !== undefined) set.ttftTimeoutMs = patch.ttftTimeoutMs;
  if (patch.totalTimeoutMs !== undefined) set.totalTimeoutMs = patch.totalTimeoutMs;
  if (patch.idleTimeoutMs !== undefined) set.idleTimeoutMs = patch.idleTimeoutMs;
  if (patch.retryCodes !== undefined) set.retryCodes = patch.retryCodes;
  if (patch.retryMessages !== undefined) set.retryMessages = patch.retryMessages;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.description !== undefined) set.description = patch.description;
  if (Object.keys(set).length === 0) {
    return getFaultPolicyById(db, id);
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(faultPolicy)
    .set(set)
    .where(and(eq(faultPolicy.id, id), isNull(faultPolicy.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke a fault policy by SOFT-DELETING it (by id). The PARTIAL unique frees its
 * `name` for a fresh re-create. Channels still referencing it keep the FK (the
 * router treats a soft-deleted policy as absent → engine defaults). Idempotent.
 */
export async function softDeleteFaultPolicy(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(faultPolicy)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(faultPolicy.id, id), isNull(faultPolicy.deletedAt)))
    .returning({ id: faultPolicy.id });
  return rows[0]?.id;
}
