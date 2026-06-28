import { useTranslation } from 'react-i18next';

import { Pill } from '../ui/Pill';
import { UsageBar } from './UsageBar';

/**
 * Structural shape shared by the admin `LimitRuleStatusView` and the tenant
 * `ConsoleLimitRuleView` — an effective rule paired with its current usage.
 */
export interface RuleStatus {
  dimension: string;
  period: string | null;
  cap: string;
  used: string;
  model_scope: string | null;
  alert_pct: number | null;
}

/**
 * Renders a subject's governance rules as usage visualisations: measurable
 * budgets (`spend`/`requests`/`tokens`) as `UsageBar`s (used-vs-cap with an
 * escalating tone), and live rate caps (`rpm`/`concurrency`) as plain pills (no
 * stored total). Shared by the operator key/tenant views and the tenant `/app`.
 */
export function LimitUsageBars({ rules }: { rules: RuleStatus[] }) {
  const { t } = useTranslation('console');
  if (rules.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      {rules.map((r, i) => {
        const dim = t('limitPlans.dim.' + r.dimension, r.dimension);
        const scope = r.model_scope !== null ? ` @${r.model_scope}` : '';
        const period =
          r.period !== null && r.dimension !== 'rpm'
            ? ` · ${t('limitPlans.period.' + r.period, r.period)}`
            : '';
        const label = `${dim}${period}${scope}`;

        if (r.dimension === 'rpm' || r.dimension === 'concurrency') {
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 'var(--fs-caption)',
                color: 'var(--muted)',
              }}
            >
              <span>{label}</span>
              <Pill tone="idle">{r.dimension === 'rpm' ? `${r.cap}/min` : `×${r.cap}`}</Pill>
            </div>
          );
        }

        return (
          <UsageBar
            key={i}
            label={label}
            used={r.used}
            cap={r.cap}
            kind={r.dimension === 'spend' ? 'money' : 'count'}
            alertPct={r.alert_pct}
          />
        );
      })}
    </div>
  );
}
