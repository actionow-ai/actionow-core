/**
 * Funding & metering an end-user. Core's money model is two-level:
 *
 *   - The TENANT pool — your app's master balance, topped up via payment
 *     (`/console/payments/intents`) or by redeeming an internal 卡密 / gift code
 *     (`/console/redeem`).
 *   - A per-subject SUB-WALLET (HARD mode) — credits ALLOCATED from the tenant
 *     pool to one end-user. Sub-wallet funding is CONSERVING: a topup/transfer
 *     moves credits from the pool, it never mints them. This is how you give each
 *     end-user a metered budget that their `ak_…` key draws down.
 *
 * If a subject has NO sub-wallet, their key spends directly against the tenant
 * pool (shared budget). Open a sub-wallet only when you want per-user isolation.
 *
 * All amounts in REQUEST bodies are HUMAN credits (numbers). All RESPONSE money
 * is a µcredit decimal STRING. None of these console routes are in the OpenAPI
 * surface yet, so they use `fetch` with the tenant-admin token.
 */

/** A per-subject sub-wallet view (money fields are µcredit strings). */
export interface SubAccountView {
  id: string;
  tenant_id: string;
  subject_id: string;
  credit_balance: string;
  credit_held: string;
  status: string;
  created_at: string;
}

async function consolePost(
  baseUrl: string,
  consoleToken: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${consoleToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${String(res.status)} ${await res.text()}`);
  }
  return res.json();
}

/** Open a HARD sub-wallet for a subject, optionally with an opening balance (human credits, from the tenant pool). */
export async function openSubWallet(
  baseUrl: string,
  consoleToken: string,
  subjectId: string,
  openingCredits?: number,
): Promise<SubAccountView> {
  const body = openingCredits === undefined ? {} : { credits: openingCredits };
  return (await consolePost(
    baseUrl,
    consoleToken,
    `/console/subjects/${subjectId}/sub-account/open`,
    body,
  )) as SubAccountView;
}

/** Top up a subject's sub-wallet by `credits` (human), allocated from the tenant pool (conserving). */
export async function topupSubWallet(
  baseUrl: string,
  consoleToken: string,
  subjectId: string,
  credits: number,
): Promise<SubAccountView> {
  return (await consolePost(
    baseUrl,
    consoleToken,
    `/console/subjects/${subjectId}/sub-account/topup`,
    { credits },
  )) as SubAccountView;
}

/**
 * Redeem an internal 卡密 / gift code into the TENANT pool. This is how an
 * offline/whitelabel funding flow tops up your master balance without a payment
 * provider; you then allocate from the pool to subjects with {@link topupSubWallet}.
 */
export async function redeemCode(
  baseUrl: string,
  consoleToken: string,
  code: string,
): Promise<{ credited: string; balance: string }> {
  return (await consolePost(baseUrl, consoleToken, '/console/redeem', { code })) as {
    credited: string;
    balance: string;
  };
}
