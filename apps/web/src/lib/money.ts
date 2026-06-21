const MICRO_DIGITS = 6;

/**
 * Format a stored µcredit decimal string as human credits, locale-grouped,
 * truncated to `maxFrac` fractional digits, computed on the integer string so
 * no value passes through a JS float.
 */
export function formatCredits(micro: string, locale = 'zh-CN', maxFrac = 2): string {
  const neg = micro.startsWith('-');
  const digits = (neg ? micro.slice(1) : micro).replace(/\D/g, '').padStart(MICRO_DIGITS + 1, '0');
  const whole = digits.slice(0, digits.length - MICRO_DIGITS);
  const fracFull = digits.slice(digits.length - MICRO_DIGITS);
  const frac = fracFull.slice(0, maxFrac).replace(/0+$/, '');
  const grouped = new Intl.NumberFormat(locale).format(BigInt(whole));
  return (neg ? '-' : '') + grouped + (frac ? `.${frac}` : '');
}

/**
 * Compare two integer µcredit strings for a DESCENDING sort (largest first),
 * via `BigInt` so values past `Number.MAX_SAFE_INTEGER` order correctly — never
 * route money through a JS float.
 */
export function compareMicroDesc(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x > y ? -1 : x < y ? 1 : 0;
}

/**
 * Like `formatCredits` but always carries a sign: `+` for positive, the native
 * `-` for negative, and no sign for zero. For signed quantities like margin.
 */
export function formatCreditsSigned(micro: string, locale = 'zh-CN', maxFrac = 2): string {
  const base = formatCredits(micro, locale, maxFrac);
  return BigInt(micro) > 0n ? `+${base}` : base; // negatives already carry '-'; zero stays unsigned
}
