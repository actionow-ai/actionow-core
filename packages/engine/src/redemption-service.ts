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
 * Redeem a code for a tenant (§C.3): atomically claim the code, then — only when
 * THIS call won the claim — credit the tenant's account via the existing `topUp`
 * ledger path (one `topup` ledger row). Idempotent on the code: a re-claim
 * returns `{redeemed:false}` and credits nothing (the claim UPDATE matched no
 * row). Throws `resource_not_found` for an unknown code, `invalid_input` for an
 * expired one, and `internal_error` when the tenant has no account.
 *
 * The console redeem route (Track B) calls this with the JWT-resolved tenant.
 */
export async function redeemCode(
  db: DbOrTx,
  code: string,
  tenantId: string,
): Promise<RedeemResult> {
  const claim = await claimRedemptionCode(db, code, tenantId);

  if (!claim.claimed) {
    if (claim.missing === true) {
      throw engineError('resource_not_found', `code ${code} not found`);
    }
    if (claim.expired === true) throw engineError('invalid_input', `code ${code} expired`);
    // Already redeemed (by this or another tenant) → idempotent no-op.
    return { redeemed: false };
  }

  if (claim.creditAmount === undefined) {
    throw engineError('internal_error', 'claimed code missing credit_amount');
  }

  const account = await getAccountByTenant(db, tenantId);
  if (account === undefined) {
    throw engineError('internal_error', `no account for tenant ${tenantId}`);
  }

  const balance = await topUp(db, account.id, tenantId, claim.creditAmount);
  return { redeemed: true, balance };
}
