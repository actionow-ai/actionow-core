/**
 * A locale-aware relative time string (e.g. "5 minutes ago" / "5分钟前") via the
 * native `Intl.RelativeTimeFormat`. Used by the audit/version badge to show
 * "last changed {when}". `locale` defaults to the runtime — pass the i18n
 * language so the string matches the rest of the UI. A future timestamp clamps
 * to "now" (audit rows are always in the past, but clock skew is possible).
 */
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

export function relativeTime(
  iso: string | number | Date,
  locale?: string,
  now = Date.now(),
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  // Seconds elapsed since `then` (negative → in the past). Clamp future to 0.
  let delta = Math.min(0, (then - now) / 1000);
  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(delta) < amount) return rtf.format(Math.round(delta), unit);
    delta /= amount;
  }
  return rtf.format(Math.round(delta), 'year');
}
