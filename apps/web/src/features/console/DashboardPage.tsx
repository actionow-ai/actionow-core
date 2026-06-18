import { CubeIcon } from '@phosphor-icons/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { RankingBar } from '../../components/console/RankingBar';
import { StatCard } from '../../components/console/StatCard';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { qk } from '../../lib/api/queryKeys';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE, STALE_VOLATILE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

export function DashboardPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const tenants = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
  });
  const resources = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
  });
  // Top models by cost — admin-wide rollup (raw array, not an envelope).
  const ranking = useQuery({
    queryKey: qk.analyticsUsage({ groupBy: 'model' }),
    queryFn: () => api.analyticsUsage({ groupBy: 'model' }),
    staleTime: STALE_VOLATILE,
  });

  const [tenantId, setTenantId] = useUrlState('tenant');
  const jobs = useQuery({
    queryKey: qk.jobs(tenantId),
    queryFn: () => api.listJobs({ tenantId, limit: 8 }),
    enabled: tenantId !== '',
    staleTime: STALE_VOLATILE,
    placeholderData: keepPreviousData,
  });

  useSetConsoleFilters(
    () => (
      <div style={{ width: 200 }}>
        <TenantSelect value={tenantId} onChange={setTenantId} placeholder={t('dashboard.stats.pickTenant')} />
      </div>
    ),
    [t, tenantId, setTenantId],
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s-3)' }}>
        <StatCard label={t('dashboard.stats.tenants')} value={tenants.data?.length ?? 0} />
        <StatCard label={t('dashboard.stats.resources')} value={resources.data?.length ?? 0} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('dashboard.ranking.title')} />
        {(ranking.data ?? []).length === 0 ? (
          <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-5)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
            {ranking.isLoading ? '' : t('dashboard.ranking.empty')}
          </div>
        ) : (
          <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
            <RankingBar rows={ranking.data ?? []} topN={5} />
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('dashboard.recentJobs')} />
        {tenantId === '' ? (
          <div className="panel" style={{ flex: 1, display: 'grid', placeItems: 'center', borderRadius: 'var(--r-md)', color: 'var(--muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-6)' }}>
            {t('dashboard.pickTenant')}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--s-2)' }}>
            <CardCollection
              rows={jobs.data?.rows ?? []}
              loading={jobs.isLoading}
              empty={t('dashboard.noJobs')}
              layout="list"
              renderCard={(r) => (
                <EntityCard
                  key={r.job_id}
                  icon={CubeIcon}
                  title={r.resource_id}
                  badge={<StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />}
                  chips={[r.exec_mode]}
                  meta={[
                    { label: t('dashboard.cols.cost'), value: r.cost !== null ? <Money micro={r.cost} /> : '—' },
                    { label: t('dashboard.cols.status'), value: new Date(r.created_at).toLocaleTimeString() },
                  ]}
                />
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
