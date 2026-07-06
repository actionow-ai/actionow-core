import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { redemptionClaim, redemptionCode } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type RedemptionCodeRow = InferSelectModel<typeof redemptionCode>;

/** Fields a caller supplies to {@link createRedemptionCode}. */
export interface CreateRedemptionCodeInput {
  readonly code: string;
  /** µcredit grant PER redemption (admin converts human credits via `creditsToMicro`). */
  readonly creditAmount: bigint;
  /** How many times the code may be redeemed (>=1; default 1 = single-use). */
  readonly maxUses?: number | undefined;
  readonly expiresAt?: Date | null | undefined;
}

/** Insert an `unused` redemption code and return it. */
export async function createRedemptionCode(
  db: DbOrTx,
  input: CreateRedemptionCodeInput,
): Promise<RedemptionCodeRow> {
  const rows = await db
    .insert(redemptionCode)
    .values({
      code: input.code,
      creditAmount: input.creditAmount,
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createRedemptionCode: insert returned no row');
  return row;
}

/** Fetch a live redemption code by its `code` PK (soft-deleted → `undefined`). */
export async function getRedemptionCode(
  db: DbOrTx,
  code: string,
): Promise<RedemptionCodeRow | undefined> {
  const rows = await db
    .select()
    .from(redemptionCode)
    .where(and(eq(redemptionCode.code, code), isNull(redemptionCode.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Optional filters for {@link listRedemptionCodes}. */
export interface ListRedemptionCodesFilter {
  /** `unused` | `redeemed`. */
  readonly status?: string | undefined;
}

/**
 * List live redemption codes (admin mint view; excludes soft-deleted),
 * keyset-paginated newest-first on `(created_at, code)`. The `code` PK is the
 * keyset tiebreaker. Returning the `code` value is acceptable here — this is an
 * admin-only mint listing, and the code IS the row's identity (no unrelated
 * secret is exposed). An optional `status` filter (`unused`/`redeemed`) composes
 * with the keyset IN SQL.
 *
 * NOTE: `redemption_code` carries no `resource_id` — codes are tenant-agnostic
 * credit grants, not resource-scoped — so only a `status` filter is supported.
 */
export function listRedemptionCodes(
  db: DbOrTx,
  filter: ListRedemptionCodesFilter,
  page: PageParams,
): Promise<KeysetResult<RedemptionCodeRow>> {
  const statusFilter =
    filter.status !== undefined ? eq(redemptionCode.status, filter.status) : undefined;
  return keysetPage<RedemptionCodeRow>(db, {
    table: redemptionCode,
    createdAtCol: redemptionCode.createdAt,
    idCol: redemptionCode.code,
    where: and(isNull(redemptionCode.deletedAt), statusFilter),
    page,
  });
}

/** The disjoint outcomes of {@link claimRedemptionCode}. */
export interface ClaimRedemptionResult {
  /** `true` iff THIS call consumed a use (caller should credit). */
  readonly claimed: boolean;
  /** The µcredit grant, present when `claimed` is `true`. */
  readonly creditAmount?: bigint;
  /** Set when the code was already redeemed — the most-recent redeeming tenant. */
  readonly alreadyRedeemedBy?: string;
  /** Set when no code with that value exists. */
  readonly missing?: boolean;
  /** Set when the code exists but is past `expires_at`. */
  readonly expired?: boolean;
  /** Set when every use of a (multi-use) code has already been consumed. */
  readonly exhausted?: boolean;
  /** Set when THIS tenant already redeemed this code (a tenant gets one use). */
  readonly alreadyClaimedByThisTenant?: boolean;
}

/**
 * Claim one use of `code` for `tenantId` (§C.3), multi-use aware (mig 0067):
 *
 *  1. Per-tenant idempotency — a tenant gets AT MOST one use of a code, so if a
 *     `redemption_claim` row already exists for (code, tenant) → not claimed
 *     (`alreadyClaimedByThisTenant`), no double-credit.
 *  2. Atomic guarded increment — a single conditional UPDATE bumps
 *     `redeemed_count` and flips `status`→`redeemed` once exhausted, gated on
 *     `status='unused' AND redeemed_count < max_uses AND not-expired`. No
 *     read-then-write window, so concurrent claims cannot over-redeem.
 *  3. Record the per-(code,tenant) claim (audit + the `unique(code,tenant)`
 *     backstop against a same-tenant concurrent double-claim).
 *
 * A no-win reads the row back to disambiguate `missing` / `expired` /
 * `exhausted`. MUST run inside the caller's transaction (as `console.redeem`
 * does) so the increment + claim row + credit settle atomically.
 */
export async function claimRedemptionCode(
  db: DbOrTx,
  code: string,
  tenantId: string,
  subjectId?: string | null,
): Promise<ClaimRedemptionResult> {
  // 1. A tenant may consume a code only once (idempotent re-claim, no credit).
  const prior = await db
    .select({ id: redemptionClaim.id })
    .from(redemptionClaim)
    .where(and(eq(redemptionClaim.code, code), eq(redemptionClaim.tenantId, tenantId)))
    .limit(1);
  if (prior[0] !== undefined) {
    return { claimed: false, alreadyClaimedByThisTenant: true, alreadyRedeemedBy: tenantId };
  }

  // 2. Atomic guarded increment. All column refs in SET read the OLD row, so the
  //    CASE sees the pre-increment count (`count + 1` is the new value).
  const updated = await db
    .update(redemptionCode)
    .set({
      redeemedCount: sql`${redemptionCode.redeemedCount} + 1`,
      status: sql`CASE WHEN ${redemptionCode.redeemedCount} + 1 >= ${redemptionCode.maxUses} THEN 'redeemed' ELSE 'unused' END`,
      redeemedByTenant: tenantId,
      redeemedAt: sql`now()`,
      subjectId: subjectId ?? null,
    })
    .where(
      and(
        eq(redemptionCode.code, code),
        eq(redemptionCode.status, 'unused'),
        isNull(redemptionCode.deletedAt),
        sql`${redemptionCode.redeemedCount} < ${redemptionCode.maxUses}`,
        sql`(${redemptionCode.expiresAt} IS NULL OR ${redemptionCode.expiresAt} > now())`,
      ),
    )
    .returning({ creditAmount: redemptionCode.creditAmount });

  const won = updated[0];
  if (won === undefined) {
    const existing = await getRedemptionCode(db, code);
    if (existing === undefined) return { claimed: false, missing: true };
    if (existing.status === 'redeemed' || existing.redeemedCount >= existing.maxUses) {
      return {
        claimed: false,
        exhausted: true,
        ...(existing.redeemedByTenant !== null
          ? { alreadyRedeemedBy: existing.redeemedByTenant }
          : {}),
      };
    }
    return { claimed: false, expired: true };
  }

  // 3. Record the claim (audit + unique(code,tenant) backstop).
  await db.insert(redemptionClaim).values({
    code,
    tenantId,
    creditAmount: won.creditAmount,
    ...(subjectId != null ? { subjectId } : {}),
  });

  return { claimed: true, creditAmount: won.creditAmount };
}
