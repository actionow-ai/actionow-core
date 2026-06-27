import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { ModelHealthCard, useOpsHealth } from '../../components/console/ModelHealthCard';
import { type HealthState } from '../../components/console/ModelHealthCard';
import { StatCard } from '../../components/console/StatCard';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { MetricBarChart } from '../../components/data/MetricBarChart';
import { Money } from '../../components/data/Money';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { TenantSelect } from '../../components/data/TenantSelect';
import { TimeSeriesChart } from '../../components/data/TimeSeriesChart';
import { DateField } from '../../components/ui/DateField';
import { Pill, type PillTone } from '../../components/ui/Pill';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { type Metric, metricMicro } from '../../lib/analyticsMetric';
import { qk } from '../../lib/api/queryKeys';
import type { AnalyticsUsageQuery, UsageRollupView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { formatCredits, formatCreditsSigned } from '../../lib/money';
import { STALE_REFERENCE, STALE_VOLATILE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

type GroupBy = AnalyticsUsageQuery['groupBy'];

const GROUP_BYS: GroupBy[] = ['day', 'hour', 'minute', 'model', 'tenant', 'channel', 'api_key'];
const METRICS: Metric[] = ['cost', 'margin', 'requests', 'tokens', 'errors'];
const TIME_GRAINS = new Set<GroupBy>(['minute', 'hour', 'day']);
/** Fixed bento height so the chart + health card stay compact (health list scrolls). */
const BENTO_H = 360;

const HEALTH_TONE: Record<HealthState, PillTone> = {
  healthy: 'ok',
  cooling: 'fail',
  reauth: 'wait',
  disabled: 'idle',
};

/** Inline "起/止 + control" wrapper for the date-range filters. */
const DATE_LABEL = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--muted)',
} as const;

/**
 * Operator OVERVIEW · ANALYTICS (the merged dashboard + analytics surface). One
 * sticky top filter is the single analytical "lens" (scope + dimension + metric +
 * date) and drives BOTH the main chart and the rollup detail table — there is no
 * separate chart-type toggle. Model health + RPM are independent operational
 * widgets (they ignore the lens). The per-call usage log lives on the relay-traces
 * page now (admin) and `/app/usage` (tenant), not here.
 */
export function OverviewPage() {
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

  // Authoritative platform counts (NOT a first-page length).
  const summary = useQuery({
    queryKey: qk.summary(),
    queryFn: () => api.getSummary(),
    staleTime: STALE_REFERENCE,
  });

  // Ops health (model-health card + KPI aggregate + billable RPM). Shared hook.
  const { aggregate: healthAgg, rpm, isLoading: healthLoading } = useOpsHealth();

  // Resolve tenant uuid buckets → names when grouping by tenant.
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

  // Totals + derived KPIs across the visible buckets (BigInt money; weighted avg latency).
  const totals = useMemo(() => {
    let requests = 0;
    let errors = 0;
    let cost = 0n;
    let margin = 0n;
    let latNum = 0;
    let latDen = 0;
    for (const r of rows) {
      requests += r.requests;
      errors += r.errors;
      cost += BigInt(r.cost);
      margin += BigInt(r.margin);
      if (r.avg_latency_ms !== null) {
        latNum += r.avg_latency_ms * r.requests;
        latDen += r.requests;
      }
    }
    const successRate = requests > 0 ? ((requests - errors) / requests) * 100 : null;
    const avgLatency = latDen > 0 ? Math.round(latNum / latDen) : null;
    return {
      requests,
      errors,
      cost: cost.toString(),
      margin: margin.toString(),
      successRate,
      avgLatency,
    };
  }, [rows]);

  // µ-string → display string (for chart tooltips) and ReactNode (for table cells).
  const fmtStr = (micro: string): string => {
    if (mt === 'cost') return formatCredits(micro, i18n.language);
    if (mt === 'margin') return formatCreditsSigned(micro, i18n.language);
    return new Intl.NumberFormat(i18n.language).format(BigInt(micro));
  };
  const fmtNode = (micro: string): ReactNode => {
    if (mt === 'cost') return <Money micro={micro} />;
    if (mt === 'margin')
      return (
        <span className="tabular" style={{ color: BigInt(micro) < 0n ? 'var(--fail)' : undefined }}>
          {formatCreditsSigned(micro, i18n.language)}
        </span>
      );
    return <span className="tabular">{fmtStr(micro)}</span>;
  };

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
      align: 'right',
      width: '90px',
    },
    {
      key: 'cost',
      header: t('analytics.cols.cost'),
      cell: (r) => <Money micro={r.cost} />,
      align: 'right',
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
      align: 'right',
      width: '110px',
    },
    {
      key: 'successRate',
      header: t('overview.cols.successRate'),
      cell: (r) => {
        if (r.requests === 0) return <span style={{ color: 'var(--faint)' }}>—</span>;
        const rate = ((r.requests - r.errors) / r.requests) * 100;
        const tone =
          rate >= 99 ? 'var(--ok)' : rate >= 95 ? 'var(--warn, var(--accent))' : 'var(--fail)';
        return (
          <span className="tabular" style={{ color: tone }}>
            {rate.toFixed(1)}%
          </span>
        );
      },
      align: 'right',
      width: '96px',
    },
    {
      key: 'p95',
      header: t('overview.cols.p95'),
      cell: (r) =>
        r.p95_latency_ms === null ? (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ) : (
          <span className="tabular">{r.p95_latency_ms.toLocaleString()} ms</span>
        ),
      align: 'right',
      width: '100px',
    },
    {
      key: 'errors',
      header: t('analytics.cols.errors'),
      cell: (r) => (
        <span style={{ color: r.errors > 0 ? 'var(--fail)' : 'var(--muted)' }}>
          {r.errors.toLocaleString()}
        </span>
      ),
      align: 'right',
      width: '80px',
    },
  ];

  const metricLabel = t(`analytics.metric.${mt}`);
  const chartTitle = TIME_GRAINS.has(gb)
    ? t('analytics.chart.trend', { metric: metricLabel })
    : t('analytics.chart.breakdown', {
        metric: metricLabel,
        dimension: t(`analytics.groupBy.${gb}`),
      });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      {/* Single-lens sticky filter (scope + dimension + metric + date) */}
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
          <TenantSelect
            value={tenantId}
            onChange={setTenantId}
            placeholder={t('analytics.allTenants')}
          />
        </div>
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
        <span style={DATE_LABEL}>
          {t('analytics.from')}
          <DateField
            value={from}
            onChange={setFrom}
            max={to === '' ? undefined : to}
            ariaLabel={t('analytics.from')}
          />
        </span>
        <span style={DATE_LABEL}>
          {t('analytics.to')}
          <DateField
            value={to}
            onChange={setTo}
            min={from === '' ? undefined : from}
            ariaLabel={t('analytics.to')}
          />
        </span>
      </div>

      {/* KPI band — perf-led, plus authoritative counts */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        <div className="glass" style={{ padding: 'var(--s-5)', borderRadius: 'var(--r-md)' }}>
          <div
            style={{
              fontSize: 'var(--fs-nano)',
              textTransform: 'uppercase',
              letterSpacing: '.06em',
              color: 'var(--muted)',
            }}
          >
            {t('overview.kpi.health')}
          </div>
          <div style={{ marginTop: 10 }}>
            {healthLoading ? (
              <span style={{ color: 'var(--faint)' }}>…</span>
            ) : (
              <Pill tone={HEALTH_TONE[healthAgg]} dot>
                {t(`overview.health.state.${healthAgg}`)}
              </Pill>
            )}
          </div>
        </div>
        <StatCard label={t('overview.kpi.rpm')} value={rpm} />
        <StatCard
          label={t('overview.kpi.successRate')}
          value={totals.successRate === null ? '—' : `${totals.successRate.toFixed(1)}%`}
        />
        <StatCard
          label={t('overview.kpi.avgLatency')}
          value={totals.avgLatency === null ? '—' : `${totals.avgLatency.toLocaleString()} ms`}
        />
        <StatCard
          label={t('analytics.stats.cost')}
          value={formatCredits(totals.cost, i18n.language)}
        />
        <StatCard
          label={t('analytics.stats.margin')}
          value={formatCreditsSigned(totals.margin, i18n.language)}
        />
        <StatCard
          label={t('overview.kpi.scale')}
          value={
            summary.data === undefined
              ? '—'
              : `${String(summary.data.tenants)} · ${String(summary.data.resources)}`
          }
        />
      </div>

      {/* Bento: main chart (lens-driven) + model-health card. Both panels share a
          fixed height; the chart centers inside it and the health list scrolls. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gap: 'var(--s-4)',
          alignItems: 'stretch',
          height: BENTO_H,
        }}
      >
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-4)',
            overflow: 'visible',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <SectionHeader title={chartTitle} />
          <div
            style={{
              marginTop: 'var(--s-3)',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <QueryBoundary query={usage}>
              {rows.length === 0 ? (
                <div
                  style={{
                    padding: 'var(--s-6)',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: 'var(--fs-sm)',
                  }}
                >
                  {t('analytics.chart.empty')}
                </div>
              ) : TIME_GRAINS.has(gb) ? (
                <>
                  <TimeSeriesChart points={series} ariaLabel={chartTitle} format={fmtStr} />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: series.length === 1 ? 'center' : 'space-between',
                      marginTop: 'var(--s-2)',
                      fontSize: 'var(--fs-caption)',
                      color: 'var(--faint)',
                    }}
                  >
                    <span>{series[0]?.label}</span>
                    {series.length > 1 && <span>{series[series.length - 1]?.label}</span>}
                  </div>
                </>
              ) : (
                <MetricBarChart bars={bars} format={fmtNode} topN={12} />
              )}
            </QueryBoundary>
          </div>
        </div>

        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-4)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <SectionHeader title={t('overview.healthTitle')} />
          <div style={{ marginTop: 'var(--s-2)', flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <ModelHealthCard />
          </div>
        </div>
      </div>

      {/* Rollup detail table (lens-driven). For a by-model cost ranking, select
          the 模型 dimension + 成本 metric above — no separate ranking widget. */}
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
