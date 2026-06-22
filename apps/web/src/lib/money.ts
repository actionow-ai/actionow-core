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
  // A non-zero amount that truncates to 0 at `maxFrac` would read as a flat "0"
  // next to a non-empty bar — emit a "smaller than the smallest representable"
  // sentinel instead (e.g. `<0.01`, negatives `>-0.01`).
  if (/[1-9]/.test(digits) && whole === '0' && frac === '') {
    const min = maxFrac === 0 ? '1' : `0.${'0'.repeat(maxFrac - 1)}1`;
    return neg ? `>-${min}` : `<${min}`;
  }
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
  // The sub-cent sentinels (`<0.01` / `>-0.01`) already encode direction — don't
  // prefix a '+'. negatives already carry '-'; zero stays unsigned.
  if (base.startsWith('<') || base.startsWith('>')) return base;
  return BigInt(micro) > 0n ? `+${base}` : base;
}
