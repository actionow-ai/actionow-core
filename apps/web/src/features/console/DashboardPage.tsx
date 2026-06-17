import { CubeIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { StatCard } from '../../components/console/StatCard';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { Money } from '../../components/data/Money';
import { StatusBadge } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function DashboardPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api.listTenants() });
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api.listResources() });

  const [tenantId, setTenantId] = useState('');
  const jobs = useQuery({
    queryKey: ['jobs', tenantId],
    queryFn: () => api.listJobs({ tenantId, limit: 8 }),
    enabled: tenantId !== '',
  });

  const filters = useMemo(
    () => (
      <div style={{ width: 200 }}>
        <TenantSelect value={tenantId} onChange={setTenantId} placeholder={t('dashboard.stats.pickTenant')} />
      </div>
    ),
    [t, tenantId],
  );
  useSetConsoleFilters(filters);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s-3)' }}>
        <StatCard label={t('dashboard.stats.tenants')} value={tenants.data?.length ?? 0} />
        <StatCard label={t('dashboard.stats.resources')} value={resources.data?.length ?? 0} />
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
                  badge={<StatusBadge status={r.status} />}
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
