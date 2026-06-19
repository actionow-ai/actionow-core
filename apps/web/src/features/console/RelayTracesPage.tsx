import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { httpTone, TraceViewer } from '../../components/console/TraceViewer';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { Pill } from '../../components/ui/Pill';
import { qk } from '../../lib/api/queryKeys';
import type { RelayTraceQuery, RelayTraceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_VOLATILE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

export function RelayTracesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const [tenantId, setTenantId] = useUrlState('tenant');
  const [provider, setProvider] = useUrlState('provider');
  const [from, setFrom] = useUrlState('from');
  const [to, setTo] = useUrlState('to');
  const [selected, setSelected] = useState<RelayTraceView | undefined>(undefined);

  const filters: RelayTraceQuery = {
    tenantId: tenantId === '' ? undefined : tenantId,
    providerType: provider === '' ? undefined : provider,
    from: from === '' ? undefined : `${from}T00:00:00Z`,
    to: to === '' ? undefined : `${to}T23:59:59Z`,
  };

  const q = useInfiniteQuery({
    queryKey: qk.relayTraces(filters as unknown as Record<string, unknown>),
    queryFn: ({ pageParam }) => api.listRelayTraces({ ...filters, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_VOLATILE,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];

  useSetConsoleFilters(
    () => (
      <div style={{ width: 200 }}>
        <TenantSelect
          value={tenantId}
          onChange={setTenantId}
          placeholder={t('relayTraces.allTenants')}
        />
      </div>
    ),
    [t, tenantId, setTenantId],
  );

  const cols: Column<RelayTraceView>[] = [
    {
      key: 'time',
      header: t('relayTraces.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
    {
      key: 'provider',
      header: t('relayTraces.cols.provider'),
      cell: (r) => r.provider_type ?? '—',
      width: '120px',
    },
    {
      key: 'method',
      header: t('relayTraces.cols.method'),
      cell: (r) => <span className="mono">{r.method}</span>,
      width: '72px',
    },
    {
      key: 'status',
      header: t('relayTraces.cols.status'),
      cell: (r) =>
        r.response_status !== null ? (
          <Pill tone={httpTone(r.response_status)}>{r.response_status}</Pill>
        ) : r.error !== null ? (
          <Pill tone="fail">{t('relayTraces.viewer.err')}</Pill>
        ) : (
          <Pill tone="idle">—</Pill>
        ),
      width: '88px',
    },
    {
      key: 'latency',
      header: t('relayTraces.cols.latency'),
      cell: (r) =>
        r.latency_ms !== null ? <span className="tabular">{r.latency_ms} ms</span> : '—',
      sortable: true,
      sortValue: (r) => r.latency_ms ?? -1,
      width: '96px',
    },
    {
      key: 'url',
      header: t('relayTraces.cols.url'),
      cell: (r) => (
        <span className="mono" style={{ color: 'var(--muted)' }}>
          {r.url}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      {/* Filter bar */}
      <div
        className="panel"
        style={{
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-3)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--s-3)',
          alignItems: 'center',
        }}
      >
        <input
          className="field"
          style={{ width: 200 }}
          placeholder={t('relayTraces.providerPlaceholder')}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--s-2)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--muted)',
          }}
        >
          {t('relayTraces.from')}
          <input
            className="field"
            type="date"
            style={{ width: 'auto' }}
            value={from}
            max={to === '' ? undefined : to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--s-2)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--muted)',
          }}
        >
          {t('relayTraces.to')}
          <input
            className="field"
            type="date"
            style={{ width: 'auto' }}
            value={to}
            min={from === '' ? undefined : from}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError}
        onRetry={() => void q.refetch()}
        empty={t('relayTraces.empty')}
        searchable
        onRowClick={(r) => setSelected(r)}
        selectedKey={selected?.id}
      />

      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Button
            variant="ghost"
            onClick={() => void q.fetchNextPage()}
            loading={q.isFetchingNextPage}
          >
            {t('relayTraces.loadMore')}
          </Button>
        </div>
      )}

      <Drawer
        open={selected !== undefined}
        title={t('relayTraces.viewer.title')}
        onClose={() => setSelected(undefined)}
        width="min(680px, 96vw)"
      >
        {selected !== undefined && <TraceViewer trace={selected} />}
      </Drawer>
    </div>
  );
}
