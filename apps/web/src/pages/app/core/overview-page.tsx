import type {
  ConsoleApiKeyView,
  ConsoleBalanceView,
  ConsoleModelView,
  ConsoleUsageLogView,
} from '@actionow/contracts';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Hourglass, KeyRound, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { apiFetch, formatMicroCredits, type PageOf, toApiStateError } from '@/api/client';
import { DateTimeText } from '@/components/common/date-time-text';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@/components/ui/data-display';

function usageStatusVariant(status: string): 'success' | 'danger' | 'neutral' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function formatCount(value: string | number): string {
  const big = typeof value === 'number' ? BigInt(Math.trunc(value)) : BigInt(value);
  return big.toLocaleString('en-US');
}

export function AppOverviewPage() {
  const { t } = useTranslation();

  const balance = useQuery({
    queryKey: ['console', 'balance'],
    queryFn: () => apiFetch<ConsoleBalanceView>('/console/balance'),
  });
  const keys = useQuery({
    queryKey: ['console', 'api-keys', 'count'],
    queryFn: () =>
      apiFetch<PageOf<ConsoleApiKeyView>>('/console/api-keys', { query: { limit: 100 } }),
  });
  const models = useQuery({
    queryKey: ['console', 'models'],
    queryFn: () => apiFetch<PageOf<ConsoleModelView>>('/console/models'),
  });
  const recent = useQuery({
    queryKey: ['console', 'usage-log', 'recent'],
    queryFn: () =>
      apiFetch<PageOf<ConsoleUsageLogView>>('/console/usage-log', { query: { limit: 10 } }),
  });

  const usageStatusLabel = (status: string): string =>
    status === 'succeeded'
      ? t('tenantCore.usage.statusSucceeded')
      : status === 'failed'
        ? t('tenantCore.usage.statusFailed')
        : status === 'canceled'
          ? t('tenantCore.usage.statusCanceled')
          : status;

  const keyCount =
    keys.data === undefined
      ? '—'
      : `${String(keys.data.data.length)}${keys.data.has_more ? '+' : ''}`;
  const modelCount = models.data === undefined ? '—' : String(models.data.data.length);

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantCore.overview.title')}
        description={t('tenantCore.overview.description')}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t('tenantCore.overview.statBalance')}
          detail={t('tenantCore.overview.statBalanceDetail')}
          value={balance.data ? formatMicroCredits(balance.data.balance) : '—'}
          icon={Wallet}
          emphasis
          loading={balance.isLoading}
        />
        <StatCard
          title={t('tenantCore.overview.statHeld')}
          detail={t('tenantCore.overview.statHeldDetail')}
          value={balance.data ? formatMicroCredits(balance.data.held) : '—'}
          icon={Hourglass}
          loading={balance.isLoading}
        />
        <StatCard
          title={t('tenantCore.overview.statKeys')}
          detail={t('tenantCore.overview.statKeysDetail')}
          value={keyCount}
          icon={KeyRound}
          loading={keys.isLoading}
        />
        <StatCard
          title={t('tenantCore.overview.statModels')}
          detail={t('tenantCore.overview.statModelsDetail')}
          value={modelCount}
          icon={Boxes}
          loading={models.isLoading}
        />
      </div>

      <Card className="mt-6 p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t('tenantCore.overview.recentUsage')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('tenantCore.overview.recentUsageDescription')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/app/usage">{t('tenantCore.overview.viewUsage')}</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/app/billing">{t('tenantCore.overview.viewBilling')}</Link>
            </Button>
          </div>
        </div>
        {recent.isLoading ? (
          <ResourceLoading rows={4} />
        ) : recent.isError ? (
          <ApiErrorNotice
            error={toApiStateError(recent.error)}
            onRetry={() => void recent.refetch()}
          />
        ) : !recent.data || recent.data.data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('tenantCore.overview.usageEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <DataTable className="min-w-full">
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead>{t('tenantCore.usage.colTime')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colModel')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colTokens')}</DataTableHead>
                  <DataTableHead>{t('tenantCore.usage.colCost')}</DataTableHead>
                  <DataTableHead>{t('common.status')}</DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {recent.data.data.map((row) => (
                  <DataTableRow key={row.id}>
                    <DataTableCell>
                      <DateTimeText value={row.created_at} className="text-sm" />
                    </DataTableCell>
                    <DataTableCell className="font-mono text-sm">{row.model}</DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {formatCount(row.input_tokens)} / {formatCount(row.output_tokens)}
                    </DataTableCell>
                    <DataTableCell>
                      <MoneyText value={row.cost} />
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
        )}
      </Card>
    </PageTransition>
  );
}
