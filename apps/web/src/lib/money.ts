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
