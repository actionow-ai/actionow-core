export const MICRO_PER_CREDIT = 1_000_000n;
export type MicroCredits = bigint;

/** Convert a human credit amount to integer µcredits (admin/import boundary only). */
export function creditsToMicro(credits: number): MicroCredits {
  return BigInt(Math.round(credits * 1_000_000));
}

/** Format µcredits as a trimmed decimal credit string for display. */
export function microToDisplay(micro: MicroCredits): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_CREDIT;
  const frac = abs % MICRO_PER_CREDIT;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  const body = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

/** Apply a whole-percent delta (e.g. -10 = 10% off, +20 = 20% add) with round-half-up. */
export function applyPercent(base: MicroCredits, percentDelta: number): MicroCredits {
  const factor = BigInt(100 + percentDelta);
  return (base * factor + 50n) / 100n;
}
