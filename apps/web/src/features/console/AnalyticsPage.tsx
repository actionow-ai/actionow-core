import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { StatCard } from '../../components/console/StatCard';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { MetricBarChart } from '../../components/data/MetricBarChart';
import { Money } from '../../components/data/Money';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { TenantSelect } from '../../components/data/TenantSelect';
import { TimeSeriesChart } from '../../components/data/TimeSeriesChart';
import { FIELD_INPUT_BASE } from '../../components/ui/fieldStyles';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { qk } from '../../lib/api/queryKeys';
import type { AnalyticsUsageQuery, UsageRollupView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { formatCredits, formatCreditsSigned } from '../../lib/money';
import { STALE_REFERENCE, STALE_VOLATILE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

type GroupBy = AnalyticsUsageQuery['groupBy'];
type Metric = 'cost' | 'margin' | 'requests' | 'tokens';

const GROUP_BYS: GroupBy[] = ['day', 'model', 'tenant', 'channel', 'api_key'];
const METRICS: Metric[] = ['cost', 'margin', 'requests', 'tokens'];

/**
 * The integer µ-string for the selected metric of one rollup. Accepts BOTH the
 * operator rollup (`UsageRollupView`, with `margin`) and the tenant rollup
 * (`ConsoleUsageRollupView`, which omits `margin`/`provider_cost`) — `margin` is
 * optional and only the admin page ever selects it.
 */
export function metricMicro(
  r: { cost: string; requests: number; input_tokens: string; output_tokens: string; margin?: string },
  metric: Metric,
): string {
  switch (metric) {
    case 'cost':
      return r.cost;
    case 'margin':
      return r.margin ?? '0';
    case 'requests':
      return String(r.requests);
    case 'tokens':
      return (BigInt(r.input_tokens) + BigInt(r.output_tokens)).toString();
  }
}

export function AnalyticsPage() {
  const { t, i18n } = useTranslation('console');
  const api = useAdminApi();

  const [groupBy, setGroupBy] = useUrlState('by', 'day');
  const [metric, setMetric] = useUrlState('metric', 'cost');
  const [tenantId, setTenantId] = useUrlState('tenant');
  const [from, setFrom] = useUrlState('from');
  const [to, setTo] = useUrlState('to');
  const gb = (GROUP_BYS as string[]).includes(groupBy) ? (groupBy as GroupBy) : 'day';
  const mt = (METRICS as string[]).includes(metric) ? (metric as Metric) : 'cost';

  const params: AnalyticsUsageQuery = useMemo(() => {
    const p: AnalyticsUsageQuery = { groupBy: gb };
    if (tenantId !== '') p.tenantId = tenantId;
    if (from !== '') p.from = `${from}T00:00:00Z`;
    if (to !== '') p.to = `${to}T23:59:59Z`;
    return p;
  }, [gb, tenantId, from, to]);

  const usage = useQuery({
    queryKey: qk.analyticsUsage(params as unknown as Record<string, unknown>),
    queryFn: () => api.analyticsUsage(params),
    staleTime: STALE_VOLATILE,
  });
  const rows = usage.data ?? [];

  // When grouping by tenant the bucket is a bare tenant UUID — resolve it to a
  // name via the tenants list (loaded only for that group-by). channel/api_key
  // have no global name list, so they stay as ids (hoverable via the chart tip).
  const tenants = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
    enabled: gb === 'tenant',
  });
  const tenantName = useMemo(() => {
    const m = new Map<string, string>();
    for (const tn of tenants.data ?? []) m.set(tn.id, tn.name);
    return m;
  }, [tenants.data]);
  const bucketLabel = (bucket: string): string =>
    gb === 'tenant' ? (tenantName.get(bucket) ?? bucket) : bucket;

  useSetConsoleFilters(
    () => (
      <div style={{ width: 200 }}>
        <TenantSelect
          value={tenantId}
          onChange={setTenantId}
          placeholder={t('analytics.allTenants')}
        />
      </div>
    ),
    [t, tenantId, setTenantId],
  );

  // Money metrics format via formatCredits (÷1e6); counts via locale grouping.
  const fmtMetric = (micro: string): ReactNode => {
    if (mt === 'cost') return <Money micro={micro} />;
    if (mt === 'margin')
      return (
        <span className="tabular" style={{ color: BigInt(micro) < 0n ? 'var(--fail)' : undefined }}>
          {formatCreditsSigned(micro, i18n.language)}
        </span>
      );
    return (
      <span className="tabular">{new Intl.NumberFormat(i18n.language).format(BigInt(micro))}</span>
    );
  };

  // Totals across the visible buckets (BigInt for money; plain ints for counts).
  const totals = useMemo(() => {
    let requests = 0;
    let errors = 0;
    let cost = 0n;
    let margin = 0n;
    for (const r of rows) {
      requests += r.requests;
      errors += r.errors;
      cost += BigInt(r.cost);
      margin += BigInt(r.margin);
    }
    return { requests, errors, cost: cost.toString(), margin: margin.toString() };
  }, [rows]);

  // Time-series wants chronological order; the bar chart sorts itself.
  const series = useMemo(
    () =>
      [...rows]
        .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
        .map((r) => ({ label: bucketLabel(r.bucket), micro: metricMicro(r, mt) })),
    [rows, mt, gb, tenantName],
  );
  const bars = useMemo(
    () => rows.map((r) => ({ label: bucketLabel(r.bucket), micro: metricMicro(r, mt) })),
    [rows, mt, gb, tenantName],
  );

  const cols: Column<UsageRollupView>[] = [
    {
      key: 'bucket',
      header: t('analytics.cols.bucket'),
      // By-channel rows deep-link into the relay traces filtered to that channel
      // (forensic drill-down). Other dimensions render as plain labels.
      cell: (r) =>
        gb === 'channel' ? (
          <Link
            to={`/console/relay-traces?channelId=${encodeURIComponent(r.bucket)}`}
            style={{ color: 'var(--accent)' }}
          >
            {bucketLabel(r.bucket)}
          </Link>
        ) : (
          bucketLabel(r.bucket)
        ),
    },
    {
      key: 'requests',
      header: t('analytics.cols.requests'),
      cell: (r) => r.requests.toLocaleString(),
      sortable: true,
      sortValue: (r) => r.requests,
      width: '96px',
    },
    {
      key: 'tokens',
      header: t('analytics.cols.tokens'),
      cell: (r) =>
        new Intl.NumberFormat(i18n.language).format(
          BigInt(r.input_tokens) + BigInt(r.output_tokens),
        ),
      width: '120px',
    },
    {
      key: 'cost',
      header: t('analytics.cols.cost'),
      cell: (r) => <Money micro={r.cost} />,
      width: '110px',
    },
    {
      key: 'providerCost',
      header: t('analytics.cols.providerCost'),
      cell: (r) => <Money micro={r.provider_cost} />,
      width: '110px',
    },
    {
      key: 'margin',
      header: t('analytics.cols.margin'),
      cell: (r) => (
        <span
          className="tabular"
          style={{ color: BigInt(r.margin) < 0n ? 'var(--fail)' : 'var(--ok)' }}
        >
          {formatCreditsSigned(r.margin, i18n.language)}
        </span>
      ),
      width: '110px',
    },
    {
      key: 'errors',
      header: t('analytics.cols.errors'),
      cell: (r) => (
        <span style={{ color: r.errors > 0 ? 'var(--fail)' : 'var(--muted)' }}>
          {r.errors.toLocaleString()}
        </span>
      ),
      width: '80px',
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
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--s-2)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--muted)',
          }}
        >
          {t('analytics.from')}
          <input
            type="date"
            value={from}
            max={to === '' ? undefined : to}
            onChange={(e) => setFrom(e.target.value)}
            className="field"
            style={{ ...FIELD_INPUT_BASE, width: 'auto' }}
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
          {t('analytics.to')}
          <input
            type="date"
            value={to}
            min={from === '' ? undefined : from}
            onChange={(e) => setTo(e.target.value)}
            className="field"
            style={{ ...FIELD_INPUT_BASE, width: 'auto' }}
          />
        </label>
      </div>

      {/* Summary stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        <StatCard label={t('analytics.stats.requests')} value={totals.requests} />
        <StatCard
          label={t('analytics.stats.cost')}
          value={formatCredits(totals.cost, i18n.language)}
        />
        <StatCard
          label={t('analytics.stats.margin')}
          value={formatCreditsSigned(totals.margin, i18n.language)}
        />
        <StatCard label={t('analytics.stats.errors')} value={totals.errors} />
      </div>

      {/* Chart */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={chartTitle} />
        <QueryBoundary query={usage}>
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
              {t('analytics.chart.empty')}
            </div>
          ) : (
            <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
              {gb === 'day' ? (
                <>
                  <TimeSeriesChart points={series} ariaLabel={chartTitle} />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginTop: 'var(--s-2)',
                      fontSize: 'var(--fs-caption)',
                      color: 'var(--faint)',
                    }}
                  >
                    <span>{series[0]?.label}</span>
                    <span>{series[series.length - 1]?.label}</span>
                  </div>
                </>
              ) : (
                <MetricBarChart bars={bars} format={fmtMetric} topN={12} />
              )}
            </div>
          )}
        </QueryBoundary>
      </div>

      {/* Detail table */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('analytics.detail.title')} />
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.bucket}
          loading={usage.isLoading}
          error={usage.isError}
          onRetry={() => void usage.refetch()}
          empty={t('analytics.chart.empty')}
          searchable
          pageSize={20}
        />
      </div>
    </div>
  );
}
