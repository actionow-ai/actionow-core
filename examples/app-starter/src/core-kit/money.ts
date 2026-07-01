export const MICRO_PER_CREDIT = 1_000_000n;

/** µcredit (string|bigint) → human credits string with up to `dp` decimals. */
export function formatCredits(micro: string | bigint, dp = 4): string {
  const v = BigInt(micro);
  const whole = v / MICRO_PER_CREDIT;
  const frac = (v % MICRO_PER_CREDIT).toString().padStart(6, '0').slice(0, dp).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** human credits → µcredit bigint. */
export function creditsToMicro(credits: number): bigint {
  return BigInt(Math.round(credits * 1_000_000));
}
