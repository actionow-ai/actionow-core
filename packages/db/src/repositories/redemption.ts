import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { redemptionCode } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type RedemptionCodeRow = InferSelectModel<typeof redemptionCode>;

/** Fields a caller supplies to {@link createRedemptionCode}. */
export interface CreateRedemptionCodeInput {
  readonly code: string;
  /** µcredit grant (admin converts human credits via `creditsToMicro`). */
  readonly creditAmount: bigint;
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

/** The disjoint outcomes of {@link claimRedemptionCode}. */
export interface ClaimRedemptionResult {
  /** `true` iff THIS call flipped unused→redeemed (caller should credit). */
  readonly claimed: boolean;
  /** The µcredit grant, present when `claimed` is `true`. */
  readonly creditAmount?: bigint;
  /** Set when the code was already redeemed (the redeeming tenant). */
  readonly alreadyRedeemedBy?: string;
  /** Set when no code with that value exists. */
  readonly missing?: boolean;
  /** Set when the code exists but is past `expires_at`. */
  readonly expired?: boolean;
}

/**
 * Atomically claim `code` for `tenantId` (§C.3). A single conditional UPDATE
 * (`WHERE status='unused' AND (expires_at IS NULL OR expires_at > now())
 * RETURNING credit_amount`) flips the row — there is no read-then-write window,
 * so concurrent claims cannot double-redeem. When the UPDATE matches nothing we
 * read the row back to disambiguate `missing` / `expired` / already-redeemed, so
 * the engine `redeemCode` no-ops idempotently on a re-claim.
 */
export async function claimRedemptionCode(
  db: DbOrTx,
  code: string,
  tenantId: string,
): Promise<ClaimRedemptionResult> {
  const updated = await db
    .update(redemptionCode)
    .set({ status: 'redeemed', redeemedByTenant: tenantId, redeemedAt: sql`now()` })
    .where(
      and(
        eq(redemptionCode.code, code),
        eq(redemptionCode.status, 'unused'),
        isNull(redemptionCode.deletedAt),
        sql`(${redemptionCode.expiresAt} IS NULL OR ${redemptionCode.expiresAt} > now())`,
      ),
    )
    .returning({ creditAmount: redemptionCode.creditAmount });

  const won = updated[0];
  if (won) return { claimed: true, creditAmount: won.creditAmount };

  const existing = await getRedemptionCode(db, code);
  if (existing === undefined) return { claimed: false, missing: true };
  if (existing.status === 'redeemed') {
    return {
      claimed: false,
      ...(existing.redeemedByTenant !== null
        ? { alreadyRedeemedBy: existing.redeemedByTenant }
        : {}),
    };
  }
  return { claimed: false, expired: true };
}
