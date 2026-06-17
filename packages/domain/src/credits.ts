export const MICRO_PER_CREDIT = 1_000_000n;
export type MicroCredits = bigint;

/**
 * Money-unit doctrine (Track 1 — billing µUSD re-anchor).
 *
 * `1 credit = $1`. A µcredit ≡ a µUSD = 1e-6 USD, so `1 USD = 1_000_000 µUSD`.
 * Balances, charges, the ledger, and `usage_log.cost` are integer µUSD (bigint,
 * int64-safe to ~$9.2e12). The existing µunit (see {@link MICRO_PER_CREDIT}) IS
 * µUSD under this anchor — the credit→micro path needs NO rescale; only the
 * topup rate (`CREDIT_RATE`, µUSD per currency minor unit) and the model-price
 * unit (µUSD per 1M tokens) change. The WIRE format stays the integer µUSD
 * value serialized as a decimal string; USD formatting is a frontend concern.
 */
export const MICRO_USD_PER_USD = 1_000_000n;

/**
 * Token-price denominator (Track 1). Model `input_price`/`output_price` are now
 * **µUSD per 1M tokens** (official `$X/1M` → `X×1e6`), so a token cost divides
 * the `tokens × ratePer1M` product by this constant with round-half-up.
 */
export const PER_1M_TOKENS = 1_000_000n;

/** Convert a human credit (USD) amount to integer µUSD (admin/import boundary only). */
export function creditsToMicro(credits: number): MicroCredits {
  return BigInt(Math.round(credits * 1_000_000));
}

/** Format µUSD as a trimmed decimal USD/credit string for display. */
export function microToDisplay(micro: MicroCredits): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_CREDIT;
  const frac = abs % MICRO_PER_CREDIT;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  const body = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

/**
 * Integer division with round-half-up, the single rounding rule for all money
 * scaling (`x / divisor`, `divisor > 0`). A `.5` fraction rounds away from zero
 * (up): `roundHalfUpDiv(500_000, 1_000_000) === 1`. Negative numerators round
 * symmetrically so a refund/charge pair stays consistent.
 */
export function roundHalfUpDiv(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new Error('roundHalfUpDiv: divisor must be positive');
  if (numerator < 0n) return -roundHalfUpDiv(-numerator, divisor);
  return (numerator + divisor / 2n) / divisor;
}

/** Apply a whole-percent delta (e.g. -10 = 10% off, +20 = 20% add) with round-half-up. */
export function applyPercent(base: MicroCredits, percentDelta: number): MicroCredits {
  const factor = BigInt(100 + percentDelta);
  return roundHalfUpDiv(base * factor, 100n);
}
