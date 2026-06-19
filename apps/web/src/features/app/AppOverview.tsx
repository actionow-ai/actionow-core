import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { StatCard } from '../../components/console/StatCard';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleJobView, ConsoleLedgerView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { formatCredits, formatCreditsSigned } from '../../lib/money';
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
  // The most recent ledger row carries the live balance.
  const balance = ledger[0]?.balance_after ?? '0';

  const jobCols: Column<ConsoleJobView>[] = [
    { key: 'resource', header: t('app.overview.cols.resource'), cell: (r) => r.resource_id },
    {
      key: 'status',
      header: t('app.overview.cols.status'),
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '110px',
    },
    { key: 'mode', header: t('app.overview.cols.mode'), cell: (r) => r.exec_mode, width: '110px' },
    {
      key: 'cost',
      header: t('app.overview.cols.cost'),
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
    { key: 'type', header: t('app.overview.cols.type'), cell: (r) => r.type },
    {
      key: 'delta',
      header: t('app.overview.cols.delta'),
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        <StatCard label={t('app.overview.balance')} value={formatCredits(balance, i18n.language)} />
        <StatCard label={t('app.overview.jobsCount')} value={jobs.length} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.overview.jobs')} />
        <DataTable
          columns={jobCols}
          rows={jobs}
          rowKey={(r) => r.job_id}
          loading={usage.isLoading}
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
          empty={t('app.overview.noLedger')}
          pageSize={10}
        />
      </div>
    </div>
  );
}
