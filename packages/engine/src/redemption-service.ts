import { claimRedemptionCode, type DbOrTx, getAccountByTenant, topUp } from '@actionow/db';

import { engineError } from './errors.js';

/** The outcome of {@link redeemCode}. */
export interface RedeemResult {
  /** `true` iff THIS call claimed the code and credited the account. */
  redeemed: boolean;
  /** The post-credit balance when `redeemed` is `true`. */
  balance?: bigint;
}

/**
 * Redeem one use of a code for a tenant (§C.3): consume a use (multi-use aware —
 * a tenant gets at most one use), then — only when THIS call won a use — credit
 * the tenant's account via the existing `topUp` ledger path (one `topup` ledger
 * row). The claim + credit run in ONE transaction so a consumed use is never left
 * uncredited (and a failed credit rolls back the use). Idempotent on the code: a
 * re-claim (exhausted / already-redeemed-by-this-tenant) returns `{redeemed:false}`
 * and credits nothing. Throws `resource_not_found` for an unknown code,
 * `invalid_input` for an expired one, and `internal_error` when the tenant has no
 * account.
 */
export async function redeemCode(
  db: DbOrTx,
  code: string,
  tenantId: string,
): Promise<RedeemResult> {
  return db.transaction(async (tx) => {
    const claim = await claimRedemptionCode(tx, code, tenantId);

    if (!claim.claimed) {
      if (claim.missing === true) {
        throw engineError('resource_not_found', `code ${code} not found`);
      }
      if (claim.expired === true) throw engineError('invalid_input', `code ${code} expired`);
      // Exhausted or already redeemed by this tenant → idempotent no-op.
      return { redeemed: false };
    }

    if (claim.creditAmount === undefined) {
      throw engineError('internal_error', 'claimed code missing credit_amount');
    }

    const account = await getAccountByTenant(tx, tenantId);
    if (account === undefined) {
      throw engineError('internal_error', `no account for tenant ${tenantId}`);
    }

    const balance = await topUp(tx, account.id, tenantId, claim.creditAmount);
    return { redeemed: true, balance };
  });
}
