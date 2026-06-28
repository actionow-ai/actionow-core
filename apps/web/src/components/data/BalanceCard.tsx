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
  held,
  heldLabel,
}: {
  micro: string;
  label: string;
  cta?: string;
  topupTo?: string;
  /** Optional held-credits µ-string; renders a muted secondary line when > 0. */
  held?: string;
  heldLabel?: string;
}) {
  const { i18n } = useTranslation();
  const showHeld = held !== undefined && heldLabel !== undefined && BigInt(held) > 0n;
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
            fontWeight: 'var(--fw-bold)',
            letterSpacing: '-.02em',
            marginTop: 6,
          }}
        >
          {formatCredits(micro, i18n.language)}
        </div>
        {showHeld && (
          <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)', marginTop: 4 }}>
            {heldLabel} {formatCredits(held, i18n.language)}
          </div>
        )}
      </div>
      {cta !== undefined && topupTo !== undefined && (
        <Button to={topupTo} variant="cta" size="sm">
          {cta}
        </Button>
      )}
    </div>
  );
}
