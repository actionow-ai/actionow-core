import { useTranslation } from 'react-i18next';

import { formatCredits } from '../../lib/money';

/** Format a bigint-string value for display: money → credits, else grouped count. */
function fmt(value: string, kind: 'money' | 'count', lang: string): string {
  if (kind === 'money') return formatCredits(value, lang);
  // Counts (requests/tokens) are safe-ish for display via Number grouping.
  return new Intl.NumberFormat(lang).format(Number(value));
}

/** Ratio used/cap in [0,1]; bigint-safe (scales to permille before Number). */
function ratio(used: string, cap: string): number {
  const c = BigInt(cap);
  if (c <= 0n) return 0;
  const permille = Number((BigInt(used) * 1000n) / c);
  return Math.min(1, permille / 1000);
}

/**
 * A labelled usage-vs-cap progress bar for one measurable governance rule
 * (`spend` / `requests` / `tokens`). The fill tone escalates ok → amber (at the
 * rule's `alert_pct`, default 80%) → red (at/over cap). Money caps render as
 * credits; count caps render grouped. Live `rpm`/`concurrency` rules have no
 * stored total and are surfaced as pills by the caller, not this bar.
 */
export function UsageBar({
  label,
  used,
  cap,
  kind,
  alertPct,
}: {
  label: string;
  used: string;
  cap: string;
  kind: 'money' | 'count';
  alertPct?: number | null;
}) {
  const { i18n } = useTranslation();
  const r = ratio(used, cap);
  const pct = Math.round(r * 100);
  const threshold = (alertPct ?? 80) / 100;
  const tone = r >= 1 ? 'var(--fail)' : r >= threshold ? 'var(--run)' : 'var(--ok)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 'var(--s-2)',
          fontSize: 'var(--fs-caption)',
        }}
      >
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <span className="tabular" style={{ color: 'var(--text)' }}>
          {fmt(used, kind, i18n.language)} / {fmt(cap, kind, i18n.language)}
          <span style={{ color: 'var(--faint)' }}> ({pct}%)</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          borderRadius: 999,
          background: 'var(--hairline)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${String(Math.max(2, pct))}%`,
            height: '100%',
            background: tone,
            borderRadius: 999,
            transition: 'width .3s ease',
          }}
        />
      </div>
    </div>
  );
}
