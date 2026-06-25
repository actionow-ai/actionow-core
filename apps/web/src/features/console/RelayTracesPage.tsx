import { useInfiniteQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { httpTone, TraceViewer } from '../../components/console/TraceViewer';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { TenantSelect } from '../../components/data/TenantSelect';
import { ComboboxField } from '../../components/ui/ComboboxField';
import { DateField } from '../../components/ui/DateField';
import { Drawer } from '../../components/ui/Drawer';
import { Pill } from '../../components/ui/Pill';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { COMMON_PROVIDERS } from '../../lib/api/enums';
import { qk } from '../../lib/api/queryKeys';
import type { RelayTraceQuery, RelayTraceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_VOLATILE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

/** Inline "起/止 + control" wrapper for the date-range filters (single label, no dup). */
const DATE_LABEL = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--muted)',
} as const;
/** Inline-labelled filter cell: label to the LEFT of the control (toolbar-friendly). */
function InlineField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
      <label
        htmlFor={id}
        style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', whiteSpace: 'nowrap' }}
      >
        {label}
      </label>
      <div style={{ width: 150 }}>{children}</div>
    </span>
  );
}

/**
 * A text input whose committed value is debounced: typing updates local state and
 * only settles to the URL/query after `delay`, so a 36-char UUID fires one query,
 * not one per keystroke. External changes (deep links / clear) sync back in.
 */
function useDebounced(
  value: string,
  commit: (v: string) => void,
  delay = 350,
): [string, (v: string) => void] {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    const id = setTimeout(() => commit(local), delay);
    return () => clearTimeout(id);
  }, [local, value, commit, delay]);
  return [local, setLocal];
}

export function RelayTracesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const [tenantId, setTenantId] = useUrlState('tenant');
  const [provider, setProvider] = useUrlState('provider');
  const [jobId, setJobId] = useUrlState('jobId');
  const [channelId, setChannelId] = useUrlState('channelId');
  const [from, setFrom] = useUrlState('from');
  const [to, setTo] = useUrlState('to');
  const [errors, setErrors] = useUrlState('errors');
  const [routeTag, setRouteTag] = useUrlState('routeTag');
  const [selected, setSelected] = useState<RelayTraceView | undefined>(undefined);

  const [providerLocal, setProviderLocal] = useDebounced(provider, setProvider);
  const [jobLocal, setJobLocal] = useDebounced(jobId, setJobId);
  const [chanLocal, setChanLocal] = useDebounced(channelId, setChannelId);
  const [tagLocal, setTagLocal] = useDebounced(routeTag, setRouteTag);

  // jobId/channelId are deep-link driven (a Job row or by-channel rollup links
  // here with `?jobId=`/`?channelId=`); all filters are URL-synced + editable.
  const filters: RelayTraceQuery = {
    tenantId: tenantId === '' ? undefined : tenantId,
    providerType: provider === '' ? undefined : provider,
    jobId: jobId === '' ? undefined : jobId,
    channelId: channelId === '' ? undefined : channelId,
    from: from === '' ? undefined : `${from}T00:00:00Z`,
    to: to === '' ? undefined : `${to}T23:59:59Z`,
    errorsOnly: errors === '1' ? true : undefined,
    routeTag: routeTag === '' ? undefined : routeTag,
  };

  const q = useInfiniteQuery({
    queryKey: qk.relayTraces(filters as unknown as Record<string, unknown>),
    queryFn: ({ pageParam }) => api.listRelayTraces({ ...filters, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_VOLATILE,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];

  // Provider suggestions = the known providers ∪ those seen in the loaded rows
  // (so subscription/relay providers like codex-oauth/seedream are offered too).
  const providerOptions = useMemo(() => {
    const set = new Set<string>(COMMON_PROVIDERS as readonly string[]);
    for (const r of rows) if (r.provider_type !== null) set.add(r.provider_type);
    return [...set];
  }, [rows]);

  /** A mono id cell that filters the list to that id on click (stops row-open). */
  const idCell = (value: string | null, apply: (v: string) => void) =>
    value === null ? (
      <span style={{ color: 'var(--faint)' }}>—</span>
    ) : (
      <button
        type="button"
        className="mono"
        title={value}
        onClick={(e) => {
          e.stopPropagation();
          apply(value);
        }}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--accent)',
          font: 'inherit',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value.slice(0, 8)}
      </button>
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
      key: 'routeTag',
      header: t('relayTraces.cols.routeTag'),
      // 染色: the canary tag the call was pinned to; a chip when set, a faint dash when not.
      cell: (r) =>
        r.route_tag !== null && r.route_tag !== '' ? (
          <Pill tone="run">{r.route_tag}</Pill>
        ) : (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ),
      width: '110px',
    },
    {
      key: 'tenant',
      header: t('relayTraces.cols.tenant'),
      cell: (r) => idCell(r.tenant_id, setTenantId),
      width: '96px',
    },
    {
      key: 'job',
      header: t('relayTraces.cols.job'),
      cell: (r) => idCell(r.job_id, setJobId),
      width: '96px',
    },
    {
      key: 'channel',
      header: t('relayTraces.cols.channel'),
      cell: (r) => idCell(r.channel_id, setChannelId),
      width: '96px',
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
      align: 'right',
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
      align: 'right',
      // No client-side sort: the list is keyset-paginated newest-first, so sorting
      // only the loaded pages would mislead. Latency stays display-only here.
      cell: (r) => (r.latency_ms !== null ? <span className="tabular">{r.latency_ms} ms</span> : '—'),
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
      {/* Sticky single-lens filter bar */}
      <div
        className="panel"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-3)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--s-3)',
          alignItems: 'center',
          backdropFilter: 'blur(8px)',
          boxShadow: 'var(--shadow-lift)',
        }}
      >
        <div style={{ minWidth: 180 }}>
          <TenantSelect value={tenantId} onChange={setTenantId} placeholder={t('relayTraces.allTenants')} />
        </div>
        <InlineField id="flt-provider" label={t('relayTraces.providerLabel')}>
          <ComboboxField
            id="flt-provider"
            value={providerLocal}
            onChange={setProviderLocal}
            options={providerOptions}
            placeholder={t('relayTraces.providerPlaceholder')}
          />
        </InlineField>
        <InlineField id="flt-job" label={t('relayTraces.jobIdLabel')}>
          <TextField
            id="flt-job"
            value={jobLocal}
            onChange={setJobLocal}
            placeholder={t('relayTraces.jobIdLabel')}
          />
        </InlineField>
        <InlineField id="flt-channel" label={t('relayTraces.channelIdLabel')}>
          <TextField
            id="flt-channel"
            value={chanLocal}
            onChange={setChanLocal}
            placeholder={t('relayTraces.channelIdLabel')}
          />
        </InlineField>
        <InlineField id="flt-route-tag" label={t('relayTraces.routeTagLabel')}>
          <TextField
            id="flt-route-tag"
            value={tagLocal}
            onChange={setTagLocal}
            placeholder={t('relayTraces.routeTagPlaceholder')}
          />
        </InlineField>
        <SegmentedControl
          ariaLabel={t('relayTraces.statusLabel')}
          value={errors}
          onChange={setErrors}
          options={[
            { value: '', label: t('relayTraces.statusAll') },
            { value: '1', label: t('relayTraces.statusErrors') },
          ]}
        />
        <span style={DATE_LABEL}>
          {t('relayTraces.from')}
          <DateField value={from} onChange={setFrom} max={to === '' ? undefined : to} ariaLabel={t('relayTraces.from')} />
        </span>
        <span style={DATE_LABEL}>
          {t('relayTraces.to')}
          <DateField value={to} onChange={setTo} min={from === '' ? undefined : from} ariaLabel={t('relayTraces.to')} />
        </span>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError}
        onRetry={() => void q.refetch()}
        empty={t('relayTraces.empty')}
        onRowClick={(r) => setSelected(r)}
        selectedKey={selected?.id}
      />

      <LoadMore
        hasNextPage={q.hasNextPage}
        isFetchingNextPage={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
      />

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
