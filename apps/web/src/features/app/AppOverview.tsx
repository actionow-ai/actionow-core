import { WarningCircleIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { BalanceCard } from '../../components/data/BalanceCard';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LimitUsageBars } from '../../components/data/LimitUsageBars';
import { Money } from '../../components/data/Money';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleJobView, ConsoleLedgerView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { formatCreditsSigned } from '../../lib/money';
import { STALE_VOLATILE } from '../../lib/query';

export function AppOverview() {
  const { t, i18n } = useTranslation('console');
  const api = useConsoleApi();

  const usage = useQuery({
    queryKey: qk.consoleUsage(),
    queryFn: () => api.usage(20),
    staleTime: STALE_VOLATILE,
  });
  const jobs = usage.data?.jobs.rows ?? [];
  const ledger = usage.data?.ledger.rows ?? [];
  // Balance now comes from the dedicated endpoint (credit balance + held).
  const balanceQ = useQuery({
    queryKey: qk.consoleBalance(),
    queryFn: () => api.balance(),
    staleTime: STALE_VOLATILE,
  });
  const balance = balanceQ.data?.balance ?? '0';
  const held = balanceQ.data?.held ?? '0';

  // Governance status: bound 额度套餐 (usage-vs-cap) + recent threshold alerts.
  const limitsQ = useQuery({
    queryKey: qk.consoleLimits(),
    queryFn: () => api.limits(),
    staleTime: STALE_VOLATILE,
  });
  const limitRules = limitsQ.data?.rules ?? [];
  const limitAlerts = limitsQ.data?.alerts ?? [];

  const jobCols: Column<ConsoleJobView>[] = [
    {
      key: 'resource',
      header: t('app.overview.cols.resource'),
      grow: true,
      cell: (r) => r.resource_id,
    },
    {
      key: 'status',
      header: t('app.overview.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '110px',
    },
    { key: 'mode', header: t('app.overview.cols.mode'), cell: (r) => r.exec_mode, width: '110px' },
    {
      key: 'cost',
      header: t('app.overview.cols.cost'),
      numeric: true,
      cell: (r) => (r.cost !== null ? <Money micro={r.cost} /> : '—'),
      width: '110px',
    },
    {
      key: 'time',
      header: t('app.overview.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
  ];

  const ledgerCols: Column<ConsoleLedgerView>[] = [
    { key: 'type', header: t('app.overview.cols.type'), grow: true, cell: (r) => r.type },
    {
      key: 'delta',
      header: t('app.overview.cols.delta'),
      numeric: true,
      cell: (r) => (
        <span
          className="tabular"
          style={{ color: BigInt(r.credits_delta) < 0n ? 'var(--fail)' : 'var(--ok)' }}
        >
          {formatCreditsSigned(r.credits_delta, i18n.language)}
        </span>
      ),
      width: '120px',
    },
    {
      key: 'balance',
      header: t('app.overview.cols.balance'),
      numeric: true,
      cell: (r) => <Money micro={r.balance_after} />,
      width: '120px',
    },
    {
      key: 'time',
      header: t('app.overview.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <QueryBoundary query={balanceQ}>
        <BalanceCard
          micro={balance}
          label={t('app.overview.balance')}
          held={held}
          heldLabel={t('app.overview.held')}
          cta={t('app.billing.submit')}
          topupTo="/app/billing"
        />
      </QueryBoundary>

      {/* Over-threshold alert banner — the tenant's recent limit crossings. */}
      {limitAlerts.length > 0 && (
        <div
          role="alert"
          className="panel"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--s-3)',
            padding: 'var(--s-3) var(--s-4)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text)',
          }}
        >
          <WarningCircleIcon
            size={18}
            weight="regular"
            style={{ color: 'var(--run)', flexShrink: 0, marginTop: 2 }}
            aria-hidden="true"
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 'var(--fw-medium)' }}>{t('app.limits.alertTitle')}</span>
            {limitAlerts.slice(0, 3).map((a, i) => (
              <span key={i} style={{ color: 'var(--muted)', fontSize: 'var(--fs-caption)' }}>
                {t('app.limits.alertLine', {
                  dim: t('limitPlans.dim.' + a.dimension, a.dimension),
                  pct: a.pct,
                  period: a.period_key,
                })}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Budget / quota usage for the bound plan. */}
      {limitRules.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <SectionHeader title={t('app.limits.title')} />
          <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
            <LimitUsageBars rules={limitRules} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader
          title={t('app.overview.jobs')}
          action={
            <Button variant="link" to="/app/usage">
              {t('app.overview.viewAll')}
            </Button>
          }
        />
        <DataTable
          columns={jobCols}
          rows={jobs}
          rowKey={(r) => r.job_id}
          loading={usage.isLoading}
          error={usage.isError}
          onRetry={() => void usage.refetch()}
          empty={t('app.overview.noJobs')}
          pageSize={10}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.overview.ledger')} />
        <DataTable
          columns={ledgerCols}
          rows={ledger}
          rowKey={(r) => r.id}
          loading={usage.isLoading}
          error={usage.isError}
          onRetry={() => void usage.refetch()}
          empty={t('app.overview.noLedger')}
          pageSize={10}
        />
      </div>
    </div>
  );
}
