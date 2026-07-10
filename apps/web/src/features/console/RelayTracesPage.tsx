import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FILTER_SELECT_MIN_W,
  InlineFilterField,
  InlineFilterLabel,
  StickyFilterBar,
} from '../../components/console/StickyFilterBar';
import { httpTone, TraceViewer } from '../../components/console/TraceViewer';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { TenantSelect } from '../../components/data/TenantSelect';
import { ComboboxField } from '../../components/ui/ComboboxField';
import { DateField } from '../../components/ui/DateField';
import { Drawer } from '../../components/ui/Drawer';
import type { PillTone } from '../../components/ui/Pill';
import { Pill } from '../../components/ui/Pill';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { COMMON_PROVIDERS } from '../../lib/api/enums';
import { qk } from '../../lib/api/queryKeys';
import type { RelayTraceQuery, RelayTraceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_VOLATILE } from '../../lib/query';
import { useDebounced } from '../../lib/useDebounced';
import { useUrlState } from '../../lib/useUrlState';

/**
 * One async TASK aggregated from the `relay_trace` rows that share a `job_id`:
 * an image/video/audio job is 1 submit + N polls, so collapsing them by job into
 * a single entry (call-count, time span, parsed task status, summed latency,
 * result hint) tames the per-poll noise. {@link TaskGroup.calls} is kept so the
 * drawer can show the raw audit calls oldest-first. A trace with no `job_id`
 * (e.g. a sync chat completion) is its own single-call task.
 */
interface TaskGroup {
  key: string;
  jobId: string | null;
  /** The task's audit calls, oldest-first (submit → polls). */
  calls: RelayTraceView[];
  /** The newest call (chronologically last) — carries the final status/result. */
  final: RelayTraceView;
  provider: string | null;
  callCount: number;
  totalLatency: number;
  /** Parsed media task status (`completed`/`processing`/`failed`/…) when present. */
  taskStatus: string | null;
  hasError: boolean;
  summary: string;
}

/** Map an async-media task status to a pill tone (falls back to neutral). */
function taskStatusTone(status: string): PillTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'error') return 'fail';
  if (status === 'processing') return 'run';
  if (status === 'pending' || status === 'queued') return 'wait';
  return 'neutral';
}

/** Pull the final media status / model / first result URL out of a poll body (best-effort). */
function parseFinal(body: string | null): { status?: string; model?: string; result?: string } {
  if (body === null || body === '') return {};
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    const status = typeof o.status === 'string' ? o.status : undefined;
    const model =
      typeof o.model_display_name === 'string'
        ? o.model_display_name
        : typeof o.model === 'string'
          ? o.model
          : undefined;
    const r = (o.result ?? {}) as Record<string, unknown>;
    const imgs = r.image_urls;
    const url =
      (typeof r.video_url === 'string' ? r.video_url : undefined) ??
      (typeof r.image_url === 'string' ? r.image_url : undefined) ??
      (typeof r.audio_url === 'string' ? r.audio_url : undefined) ??
      (Array.isArray(imgs) && typeof imgs[0] === 'string' ? imgs[0] : undefined);
    return {
      ...(status !== undefined ? { status } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(url !== undefined ? { result: url } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Bucket the loaded (newest-first) trace rows by `job_id` into {@link TaskGroup}s,
 * preserving first-seen order so the task list stays newest-first. A media task's
 * calls are temporally clustered, so grouping the loaded page captures whole tasks
 * reliably; “Load more” extends both the rows and the derived tasks.
 */
function buildTasks(rows: RelayTraceView[]): TaskGroup[] {
  const map = new Map<string, RelayTraceView[]>();
  for (const r of rows) {
    const key = r.job_id ?? `solo:${r.id}`;
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  const tasks: TaskGroup[] = [];
  for (const [key, list] of map) {
    const final = list[0]; // newest (rows are newest-first)
    if (final === undefined) continue;
    const parsed = parseFinal(final.response_body);
    const summaryParts: string[] = [];
    if (parsed.model !== undefined) summaryParts.push(parsed.model);
    if (parsed.result !== undefined) {
      const u = parsed.result;
      summaryParts.push(`→ ${u.length > 48 ? `${u.slice(0, 48)}…` : u}`);
    }
    tasks.push({
      key,
      jobId: final.job_id,
      calls: [...list].reverse(), // oldest-first for the drawer
      final,
      provider: final.provider_type,
      callCount: list.length,
      totalLatency: list.reduce((s, r) => s + (r.latency_ms ?? 0), 0),
      taskStatus: parsed.status ?? null,
      hasError: list.some((r) => r.error !== null || (r.response_status ?? 0) >= 400),
      summary: summaryParts.join(' '),
    });
  }
  return tasks;
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
  // '' = flat call list (default); 'tasks' = aggregate by job_id.
  const [view, setView] = useUrlState('view');
  const [selected, setSelected] = useState<RelayTraceView | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState<TaskGroup | undefined>(undefined);

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
    queryKey: qk.relayTraces(filters),
    queryFn: ({ pageParam }) => api.listRelayTraces({ ...filters, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_VOLATILE,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const grouped = view === 'tasks';
  const tasks = useMemo(() => (grouped ? buildTasks(rows) : []), [grouped, rows]);

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
      noClip: true,
      // 染色: the canary tag the call was pinned to; a chip when set, a faint dash when not.
      cell: (r) =>
        r.route_tag !== null && r.route_tag !== '' ? (
          <Pill tone="neutral">{r.route_tag}</Pill>
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
      noClip: true,
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
      cell: (r) =>
        r.latency_ms !== null ? <span className="tabular">{r.latency_ms} ms</span> : '—',
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

  /** Task-aggregated columns: one row per job_id (submit + N polls collapsed). */
  const taskCols: Column<TaskGroup>[] = [
    {
      key: 'span',
      header: t('relayTraces.task.cols.span'),
      cell: (tk) => new Date(tk.final.created_at).toLocaleString(),
      width: '170px',
    },
    {
      key: 'provider',
      header: t('relayTraces.task.cols.provider'),
      cell: (tk) => tk.provider ?? '—',
      width: '120px',
    },
    {
      key: 'job',
      header: t('relayTraces.task.cols.job'),
      cell: (tk) =>
        tk.jobId === null ? (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ) : (
          <span className="mono" title={tk.jobId} style={{ color: 'var(--muted)' }}>
            {tk.jobId.slice(0, 8)}
          </span>
        ),
      width: '96px',
    },
    {
      key: 'calls',
      header: t('relayTraces.task.cols.calls'),
      align: 'right',
      cell: (tk) => <span className="tabular">{tk.callCount}</span>,
      width: '72px',
    },
    {
      key: 'status',
      header: t('relayTraces.task.cols.status'),
      align: 'right',
      noClip: true,
      cell: (tk) =>
        tk.taskStatus !== null ? (
          <Pill tone={taskStatusTone(tk.taskStatus)}>{tk.taskStatus}</Pill>
        ) : tk.final.response_status !== null ? (
          <Pill tone={httpTone(tk.final.response_status)}>{tk.final.response_status}</Pill>
        ) : tk.hasError ? (
          <Pill tone="fail">{t('relayTraces.viewer.err')}</Pill>
        ) : (
          <Pill tone="idle">—</Pill>
        ),
      width: '116px',
    },
    {
      key: 'latency',
      header: t('relayTraces.task.cols.latency'),
      align: 'right',
      cell: (tk) => <span className="tabular">{tk.totalLatency} ms</span>,
      width: '100px',
    },
    {
      key: 'summary',
      header: t('relayTraces.task.cols.summary'),
      cell: (tk) => (
        <span className="mono" style={{ color: 'var(--muted)' }}>
          {tk.summary === '' ? tk.final.url : tk.summary}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      {/* Sticky single-lens filter bar */}
      <StickyFilterBar>
        <SegmentedControl
          ariaLabel={t('relayTraces.viewLabel')}
          value={view}
          onChange={setView}
          options={[
            { value: '', label: t('relayTraces.view.calls') },
            { value: 'tasks', label: t('relayTraces.view.tasks') },
          ]}
        />
        <div style={{ minWidth: FILTER_SELECT_MIN_W }}>
          <TenantSelect
            value={tenantId}
            onChange={setTenantId}
            placeholder={t('relayTraces.allTenants')}
          />
        </div>
        <InlineFilterField id="flt-provider" label={t('relayTraces.providerLabel')}>
          <ComboboxField
            id="flt-provider"
            value={providerLocal}
            onChange={setProviderLocal}
            options={providerOptions}
            placeholder={t('relayTraces.providerPlaceholder')}
          />
        </InlineFilterField>
        <InlineFilterField id="flt-job" label={t('relayTraces.jobIdLabel')}>
          <TextField id="flt-job" value={jobLocal} onChange={setJobLocal} />
        </InlineFilterField>
        <InlineFilterField id="flt-channel" label={t('relayTraces.channelIdLabel')}>
          <TextField id="flt-channel" value={chanLocal} onChange={setChanLocal} />
        </InlineFilterField>
        <InlineFilterField id="flt-route-tag" label={t('relayTraces.routeTagLabel')}>
          <TextField
            id="flt-route-tag"
            value={tagLocal}
            onChange={setTagLocal}
            placeholder={t('relayTraces.routeTagPlaceholder')}
          />
        </InlineFilterField>
        <SegmentedControl
          ariaLabel={t('relayTraces.statusLabel')}
          value={errors}
          onChange={setErrors}
          options={[
            { value: '', label: t('relayTraces.statusAll') },
            { value: '1', label: t('relayTraces.statusErrors') },
          ]}
        />
        <InlineFilterLabel text={t('relayTraces.from')}>
          <DateField
            value={from}
            onChange={setFrom}
            max={to === '' ? undefined : to}
            ariaLabel={t('relayTraces.from')}
          />
        </InlineFilterLabel>
        <InlineFilterLabel text={t('relayTraces.to')}>
          <DateField
            value={to}
            onChange={setTo}
            min={from === '' ? undefined : from}
            ariaLabel={t('relayTraces.to')}
          />
        </InlineFilterLabel>
      </StickyFilterBar>

      {grouped ? (
        <DataTable
          columns={taskCols}
          rows={tasks}
          rowKey={(tk) => tk.key}
          loading={q.isLoading}
          error={q.isError}
          onRetry={() => void q.refetch()}
          empty={t('relayTraces.task.empty')}
          onRowClick={(tk) => setSelectedTask(tk)}
          selectedKey={selectedTask?.key}
        />
      ) : (
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
      )}

      <LoadMore
        hasNextPage={q.hasNextPage}
        isFetchingNextPage={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
      />

      {/* Flat-view: one call. */}
      <Drawer
        open={selected !== undefined}
        title={t('relayTraces.viewer.title')}
        onClose={() => setSelected(undefined)}
        width="min(680px, 96vw)"
      >
        {selected !== undefined && <TraceViewer trace={selected} />}
      </Drawer>

      {/* Task-view: the job's audit calls oldest-first, each call collapsible. */}
      <Drawer
        open={selectedTask !== undefined}
        title={t('relayTraces.task.drawerTitle')}
        onClose={() => setSelectedTask(undefined)}
        width="min(680px, 96vw)"
      >
        {selectedTask !== undefined && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}
            >
              {selectedTask.taskStatus !== null && (
                <Pill tone={taskStatusTone(selectedTask.taskStatus)}>
                  {selectedTask.taskStatus}
                </Pill>
              )}
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                {t('relayTraces.task.callsN', { n: selectedTask.callCount })} ·{' '}
                {selectedTask.provider ?? '—'} ·{' '}
                <span className="tabular">{selectedTask.totalLatency} ms</span>
              </span>
            </div>
            {selectedTask.calls.map((c, i) => (
              <details key={c.id} open={i === 0 || i === selectedTask.calls.length - 1}>
                <summary
                  className="mono"
                  style={{
                    cursor: 'pointer',
                    fontSize: 'var(--fs-caption)',
                    color: 'var(--muted)',
                    padding: 'var(--s-1) 0',
                  }}
                >
                  {c.method} {c.response_status ?? c.error ?? '—'} ·{' '}
                  {c.latency_ms !== null ? `${String(c.latency_ms)} ms` : '—'}
                </summary>
                <div style={{ paddingTop: 'var(--s-2)' }}>
                  <TraceViewer trace={c} />
                </div>
              </details>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}
