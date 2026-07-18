import type { UsageLogView, UsageRollupView } from '@actionow/contracts';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Coins, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, formatMicroCredits, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableToolbar,
} from '@/components/ui/data-display';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type GroupBy = 'model' | 'day' | 'hour' | 'minute' | 'tenant' | 'channel' | 'api_key';

const GROUP_OPTIONS: GroupBy[] = ['model', 'day', 'hour', 'minute', 'tenant', 'channel', 'api_key'];
const TIME_GROUPS: GroupBy[] = ['minute', 'hour', 'day'];

const usageStatusVariant: Record<string, 'success' | 'danger' | 'neutral'> = {
  succeeded: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

function shortId(id: string | null): string {
  return id === null ? '—' : id.slice(0, 8);
}

/** Sum µ-unit decimal strings with BigInt; `null` when a value fails to parse. */
function sumMicro(rows: UsageRollupView[], pick: (row: UsageRollupView) => string): string | null {
  try {
    return rows.reduce((total, row) => total + BigInt(pick(row)), 0n).toString();
  } catch {
    return null;
  }
}

export function UsageAnalyticsPage() {
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<GroupBy>('model');

  const rollups = useQuery({
    queryKey: ['admin', 'analytics', 'usage', groupBy],
    queryFn: () => apiFetch<UsageRollupView[]>('/admin/analytics/usage', { query: { groupBy } }),
  });

  const log = useCursorQuery<UsageLogView>({
    key: ['admin', 'usage', 'log'],
    path: '/admin/usage',
  });

  const rollupRows = rollups.data ?? [];
  const totalRequests = rollupRows.reduce((total, row) => total + row.requests, 0);
  const totalErrors = rollupRows.reduce((total, row) => total + row.errors, 0);
  const totalCost = sumMicro(rollupRows, (row) => row.cost);
  const totalMargin = sumMicro(rollupRows, (row) => row.margin);

  const groupLabels: Record<GroupBy, string> = {
    model: t('opsPages.groupModel'),
    day: t('opsPages.groupDay'),
    hour: t('opsPages.groupHour'),
    minute: t('opsPages.groupMinute'),
    tenant: t('opsPages.groupTenant'),
    channel: t('opsPages.groupChannel'),
    api_key: t('opsPages.groupApiKey'),
  };
  const bucketHeaders: Record<GroupBy, string> = {
    model: t('opsPages.bucketModel'),
    day: t('opsPages.bucketTime'),
    hour: t('opsPages.bucketTime'),
    minute: t('opsPages.bucketTime'),
    tenant: t('opsPages.bucketTenant'),
    channel: t('opsPages.bucketChannel'),
    api_key: t('opsPages.bucketApiKey'),
  };
  const isTimeGroup = TIME_GROUPS.includes(groupBy);

  const statusLabel = (status: string) =>
    status === 'succeeded'
      ? t('opsPages.statusSucceeded')
      : status === 'failed'
        ? t('opsPages.statusFailed')
        : status === 'canceled'
          ? t('opsPages.statusCanceled')
          : status;

  return (
    <PageTransition>
      <PageHeader title={t('opsPages.usageTitle')} description={t('opsPages.usageDescription')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t('opsPages.statRequests')}
          detail={t('opsPages.statRequestsDetail')}
          value={rollups.data ? String(totalRequests) : '—'}
          icon={Activity}
          emphasis
          loading={rollups.isLoading}
        />
        <StatCard
          title={t('opsPages.statCost')}
          detail={t('opsPages.statCostDetail')}
          value={rollups.data ? formatMicroCredits(totalCost) : '—'}
          icon={Coins}
          loading={rollups.isLoading}
        />
        <StatCard
          title={t('opsPages.statMargin')}
          detail={t('opsPages.statMarginDetail')}
          value={rollups.data ? formatMicroCredits(totalMargin) : '—'}
          icon={TrendingUp}
          loading={rollups.isLoading}
        />
        <StatCard
          title={t('opsPages.statErrors')}
          detail={t('opsPages.statErrorsDetail')}
          value={rollups.data ? String(totalErrors) : '—'}
          icon={AlertTriangle}
          loading={rollups.isLoading}
        />
      </div>

      <Card className="mt-6 overflow-hidden">
        <DataTableToolbar
          title={t('opsPages.rollupTitle')}
          onRefresh={() => void rollups.refetch()}
          refreshing={rollups.isFetching}
        >
          <Select value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)}>
            <SelectTrigger className="w-40" aria-label={t('opsPages.groupBy')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUP_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {groupLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DataTableToolbar>

        {rollups.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : rollups.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(rollups.error)}
              onRetry={() => void rollups.refetch()}
            />
          </div>
        ) : rollupRows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t('opsPages.rollupEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <DataTable className="min-w-[1080px]">
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead>{bucketHeaders[groupBy]}</DataTableHead>
                  <DataTableHead>{t('opsPages.colRequests')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colInputTokens')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colOutputTokens')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colCost')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colProviderCost')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colMargin')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colErrors')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colAvgLatency')}</DataTableHead>
                  <DataTableHead>{t('opsPages.colP95Latency')}</DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {rollupRows.map((row) => (
                  <DataTableRow key={row.bucket}>
                    <DataTableCell>
                      {isTimeGroup ? (
                        <DateTimeText value={row.bucket} className="text-xs" />
                      ) : (
                        <span
                          className="block max-w-56 truncate font-mono text-sm"
                          title={row.bucket}
                        >
                          {row.bucket}
                        </span>
                      )}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">{row.requests}</DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {row.input_tokens}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {row.output_tokens}
                    </DataTableCell>
                    <DataTableCell>
                      <MoneyText value={row.cost} />
                    </DataTableCell>
                    <DataTableCell>
                      <MoneyText value={row.provider_cost} />
                    </DataTableCell>
                    <DataTableCell>
                      <MoneyText
                        value={row.margin}
                        className={row.margin.startsWith('-') ? 'text-danger' : undefined}
                      />
                    </DataTableCell>
                    <DataTableCell
                      className={
                        row.errors > 0
                          ? 'font-mono tabular-nums text-danger'
                          : 'font-mono tabular-nums'
                      }
                    >
                      {row.errors}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {row.avg_latency_ms === null
                        ? '—'
                        : `${String(Math.round(row.avg_latency_ms))} ms`}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {row.p95_latency_ms === null
                        ? '—'
                        : `${String(Math.round(row.p95_latency_ms))} ms`}
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </div>
        )}
      </Card>

      <Card className="mt-6 overflow-hidden">
        <DataTableToolbar
          title={t('opsPages.logTitle')}
          onRefresh={() => void log.refetch()}
          refreshing={log.isRefetching}
        />

        {log.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={6} />
          </div>
        ) : log.isError ? (
          <div className="p-4">
            <ApiErrorNotice error={toApiStateError(log.error)} onRetry={() => void log.refetch()} />
          </div>
        ) : log.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t('opsPages.logEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable className="min-w-[960px]">
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('opsPages.colTime')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colModel')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colTokens')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colCost')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colLatency')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colRouteTag')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colTenant')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colSubject')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {log.rows.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="whitespace-nowrap">
                        <DateTimeText value={row.created_at} className="text-xs" />
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.model}</DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.input_tokens} / {row.output_tokens}
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.cost} />
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.latency_ms === null ? '—' : `${String(row.latency_ms)} ms`}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={usageStatusVariant[row.status] ?? 'neutral'}>
                          {statusLabel(row.status)}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.route_tag ?? '—'}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {shortId(row.tenant_id)}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {shortId(row.subject_id)}
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="px-4 pb-4">
              <LoadMore
                count={log.rows.length}
                hasMore={log.hasNextPage}
                loading={log.isFetchingNextPage}
                onLoadMore={() => void log.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>
    </PageTransition>
  );
}
