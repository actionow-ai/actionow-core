import type { ConsoleUsageLogView, ConsoleUsageRollupView } from '@actionow/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
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

type RollupGroup = 'model' | 'day' | 'api_key';

function usageStatusVariant(status: string): 'success' | 'danger' | 'neutral' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function formatCount(value: string | number): string {
  const big = typeof value === 'number' ? BigInt(Math.trunc(value)) : BigInt(value);
  return big.toLocaleString('en-US');
}

function formatLatency(value: number | null): string {
  if (value === null) return '—';
  return `${String(Math.round(value))} ms`;
}

export function AppUsagePage() {
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<RollupGroup>('model');

  const rollup = useQuery({
    queryKey: ['console', 'analytics-usage', groupBy],
    queryFn: () =>
      apiFetch<ConsoleUsageRollupView[]>('/console/analytics/usage', { query: { groupBy } }),
  });
  const log = useCursorQuery<ConsoleUsageLogView>({
    key: ['console', 'usage-log'],
    path: '/console/usage-log',
    limit: 50,
  });

  const usageStatusLabel = (status: string): string =>
    status === 'succeeded'
      ? t('tenantCore.usage.statusSucceeded')
      : status === 'failed'
        ? t('tenantCore.usage.statusFailed')
        : status === 'canceled'
          ? t('tenantCore.usage.statusCanceled')
          : status;

  const bucketHeader =
    groupBy === 'model'
      ? t('tenantCore.usage.bucketModel')
      : groupBy === 'day'
        ? t('tenantCore.usage.bucketDay')
        : t('tenantCore.usage.bucketApiKey');

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantCore.usage.title')}
        description={t('tenantCore.usage.description')}
      />

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t('tenantCore.usage.rollupTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('tenantCore.usage.rollupDescription')}
            </p>
          </div>
          <Select value={groupBy} onValueChange={(value) => setGroupBy(value as RollupGroup)}>
            <SelectTrigger className="w-36 shrink-0" aria-label={t('tenantCore.usage.groupBy')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="model">{t('tenantCore.usage.groupModel')}</SelectItem>
              <SelectItem value="day">{t('tenantCore.usage.groupDay')}</SelectItem>
              <SelectItem value="api_key">{t('tenantCore.usage.groupApiKey')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {rollup.isLoading ? (
          <ResourceLoading rows={3} />
        ) : rollup.isError ? (
          <ApiErrorNotice
            error={toApiStateError(rollup.error)}
            onRetry={() => void rollup.refetch()}
          />
        ) : !rollup.data || rollup.data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('tenantCore.usage.rollupEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <DataTable className="min-w-full">
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead>{bucketHeader}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colRequests')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colInputTokens')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colOutputTokens')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colCost')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colErrors')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colAvgLatency')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colP95Latency')}</DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {rollup.data.map((row) => (
                  <DataTableRow key={row.bucket}>
                    <DataTableCell className="max-w-56 truncate font-mono text-sm">
                      {row.bucket}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatCount(row.requests)}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatCount(row.input_tokens)}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatCount(row.output_tokens)}
                    </DataTableCell>
                    <DataTableCell>
                      <MoneyText value={row.cost} />
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatCount(row.errors)}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatLatency(row.avg_latency_ms)}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatLatency(row.p95_latency_ms)}
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <DataTableToolbar
          title={t('tenantCore.usage.logTitle')}
          onRefresh={() => void log.refetch()}
          refreshing={log.isRefetching}
        />
        {log.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : log.isError ? (
          <ApiErrorNotice
            error={toApiStateError(log.error)}
            onRetry={() => void log.refetch()}
            className="m-4"
          />
        ) : log.rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t('tenantCore.usage.logEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('tenantCore.usage.colTime')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.usage.colModel')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.usage.colSubject')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.usage.colTokens')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.usage.colCost')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.usage.colLatency')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {log.rows.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>
                        <DateTimeText value={row.created_at} className="text-sm" />
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.model}</DataTableCell>
                      <DataTableCell>
                        {row.subject_id === null ? (
                          <span className="text-sm text-muted-foreground">—</span>
                        ) : (
                          <span className="font-mono text-sm">{row.subject_id.slice(0, 8)}</span>
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {formatCount(row.input_tokens)} / {formatCount(row.output_tokens)}
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.cost} />
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {formatLatency(row.latency_ms)}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={usageStatusVariant(row.status)}>
                          {usageStatusLabel(row.status)}
                        </Badge>
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="border-t px-4 pb-3">
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
