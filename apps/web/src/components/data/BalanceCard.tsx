import { useTranslation } from 'react-i18next';

import { formatCredits } from '../../lib/money';
import { Button } from '../ui/Button';

/**
 * The tenant home's prominent credit-balance card: a big, locale-grouped
 * `Money` figure (µ-string ÷ 1e6, BigInt-safe) with an optional self-top-up CTA.
 * Interim source today is the latest `balance_after` from `GET /console/usage`'s
 * ledger envelope (no dedicated `/console/balance` endpoint yet).
 */
export function BalanceCard({
  micro,
  label,
  cta,
  topupTo,
}: {
  micro: string;
  label: string;
  cta?: string;
  topupTo?: string;
}) {
  const { i18n } = useTranslation();
  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--s-4)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--fs-nano)',
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            color: 'var(--muted)',
          }}
        >
          {label}
        </div>
        <div
          className="tabular"
          style={{
            fontSize: 'var(--fs-2xl)',
            fontWeight: 800,
            letterSpacing: '-.02em',
            marginTop: 6,
          }}
        >
          {formatCredits(micro, i18n.language)}
        </div>
      </div>
      {cta !== undefined && topupTo !== undefined && (
        <Button to={topupTo} variant="cta" size="sm">
          {cta}
        </Button>
      )}
    </div>
  );
}
