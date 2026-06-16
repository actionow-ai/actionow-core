import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { StatCard } from '../../components/console/StatCard';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Money } from '../../components/data/Money';
import { StatusBadge } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import type { JobView } from '../../lib/api/types';
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

  const columns: Column<JobView>[] = [
    { key: 'resource', header: t('dashboard.cols.resource'), cell: (r) => r.resource_id },
    { key: 'mode', header: t('dashboard.cols.execMode'), cell: (r) => <span className="tabular">{r.exec_mode}</span> },
    { key: 'cost', header: t('dashboard.cols.cost'), cell: (r) => (r.cost ? <Money micro={r.cost} /> : '—') },
    { key: 'status', header: t('dashboard.cols.status'), cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--s-3)' }}>
        <StatCard label={t('dashboard.stats.tenants')} value={tenants.data?.length ?? 0} />
        <StatCard label={t('dashboard.stats.resources')} value={resources.data?.length ?? 0} />
      </div>

      <div style={{ width: 220 }}>
        <TenantSelect label={t('dashboard.stats.pickTenant')} value={tenantId} onChange={setTenantId} placeholder="—" />
      </div>

      {tenantId ? (
        <DataTable
          columns={columns}
          rows={jobs.data?.rows ?? []}
          rowKey={(r) => r.job_id}
          loading={jobs.isLoading}
          empty={t('dashboard.recentJobs')}
        />
      ) : (
        <div
          className="panel"
          style={{ padding: 'var(--s-6)', textAlign: 'center', color: 'var(--muted)', fontSize: 12, borderRadius: 'var(--r-md)' }}
        >
          {t('dashboard.pickTenant')}
        </div>
      )}
    </div>
  );
}
