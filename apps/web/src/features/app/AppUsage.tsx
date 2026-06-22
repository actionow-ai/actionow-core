import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { MetricBarChart } from '../../components/data/MetricBarChart';
import { Money } from '../../components/data/Money';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { TimeSeriesChart } from '../../components/data/TimeSeriesChart';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleAnalyticsQuery, ConsoleUsageLogView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_VOLATILE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';
import { metricMicro } from '../console/AnalyticsPage';

type GroupBy = ConsoleAnalyticsQuery['groupBy'];
// NOTE: no `margin` — the tenant view deliberately omits provider_cost/margin
// (operator-only; exposing them would leak the platform's per-tenant markup).
type Metric = 'cost' | 'requests' | 'tokens';
const GROUP_BYS: GroupBy[] = ['day', 'model', 'channel', 'api_key'];
const METRICS: Metric[] = ['cost', 'requests', 'tokens'];

export function AppUsage() {
  const { t, i18n } = useTranslation('console');
  const api = useConsoleApi();

  const [groupBy, setGroupBy] = useUrlState('by', 'day');
  const [metric, setMetric] = useUrlState('metric', 'cost');
  const gb = (GROUP_BYS as string[]).includes(groupBy) ? (groupBy as GroupBy) : 'day';
  const mt = (METRICS as string[]).includes(metric) ? (metric as Metric) : 'cost';

  const analytics = useQuery({
    queryKey: qk.consoleAnalytics({ groupBy: gb }),
    queryFn: () => api.analyticsUsage({ groupBy: gb }),
    staleTime: STALE_VOLATILE,
  });
  const rows = analytics.data ?? [];

  const log = useInfiniteQuery({
    queryKey: qk.consoleUsageLog(),
    queryFn: ({ pageParam }) => api.usageLog({ limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_VOLATILE,
  });
  const logRows = log.data?.pages.flatMap((p) => p.rows) ?? [];

  const fmtMetric = (micro: string): ReactNode => {
    if (mt === 'cost') return <Money micro={micro} />;
    return (
      <span className="tabular">{new Intl.NumberFormat(i18n.language).format(BigInt(micro))}</span>
    );
  };

  const series = useMemo(
    () =>
      [...rows]
        .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
        .map((r) => ({ label: r.bucket, micro: metricMicro(r, mt) })),
    [rows, mt],
  );
  const bars = useMemo(
    () => rows.map((r) => ({ label: r.bucket, micro: metricMicro(r, mt) })),
    [rows, mt],
  );

  const cols: Column<ConsoleUsageLogView>[] = [
    {
      key: 'time',
      header: t('app.usage.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
    {
      key: 'model',
      header: t('app.usage.cols.model'),
      cell: (r) => <span className="mono">{r.model}</span>,
    },
    {
      key: 'tokens',
      header: t('app.usage.cols.tokens'),
      cell: (r) => (r.input_tokens + r.output_tokens).toLocaleString(),
      width: '110px',
    },
    {
      key: 'cost',
      header: t('app.usage.cols.cost'),
      cell: (r) => <Money micro={r.cost} />,
      width: '110px',
    },
    {
      key: 'latency',
      header: t('app.usage.cols.latency'),
      cell: (r) => (r.latency_ms !== null ? `${String(r.latency_ms)} ms` : '—'),
      width: '96px',
    },
    {
      key: 'status',
      header: t('app.usage.cols.status'),
      cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />,
      width: '110px',
    },
  ];

  const metricLabel = t(`analytics.metric.${mt}`);
  const chartTitle =
    gb === 'day'
      ? t('analytics.chart.trend', { metric: metricLabel })
      : t('analytics.chart.breakdown', {
          metric: metricLabel,
          dimension: t(`analytics.groupBy.${gb}`),
        });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
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
        <SegmentedControl
          ariaLabel={t('analytics.groupByLabel')}
          value={gb}
          onChange={setGroupBy}
          options={GROUP_BYS.map((g) => ({ value: g, label: t(`analytics.groupBy.${g}`) }))}
        />
        <SegmentedControl
          ariaLabel={t('analytics.metricLabel')}
          value={mt}
          onChange={setMetric}
          options={METRICS.map((m) => ({ value: m, label: t(`analytics.metric.${m}`) }))}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={chartTitle} />
        <QueryBoundary query={analytics}>
          {rows.length === 0 ? (
            <div
              className="panel"
              style={{
                borderRadius: 'var(--r-md)',
                padding: 'var(--s-6)',
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              {t('app.usage.empty')}
            </div>
          ) : (
            <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
              {gb === 'day' ? (
                <TimeSeriesChart points={series} ariaLabel={chartTitle} />
              ) : (
                <MetricBarChart bars={bars} format={fmtMetric} topN={10} />
              )}
            </div>
          )}
        </QueryBoundary>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.usage.log')} />
        <DataTable
          columns={cols}
          rows={logRows}
          rowKey={(r) => r.id}
          loading={log.isLoading}
          error={log.isError}
          onRetry={() => void log.refetch()}
          empty={t('app.usage.noLog')}
          searchable
        />
        {log.hasNextPage && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Button
              variant="ghost"
              onClick={() => void log.fetchNextPage()}
              loading={log.isFetchingNextPage}
            >
              {t('relayTraces.loadMore')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
