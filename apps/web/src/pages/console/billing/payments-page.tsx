import type { PaymentIntentView } from '@actionow/contracts';
import { CreditCard } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
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
  DataTableToolbar,
} from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';

const paymentStatusVariant: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  succeeded: 'success',
  pending: 'warning',
  created: 'warning',
  failed: 'danger',
  expired: 'danger',
  refunded: 'neutral',
};

const paymentStatusKey: Record<string, string> = {
  created: 'billingAdmin.paymentStatusCreated',
  pending: 'billingAdmin.paymentStatusPending',
  succeeded: 'billingAdmin.paymentStatusSucceeded',
  failed: 'billingAdmin.paymentStatusFailed',
  expired: 'billingAdmin.paymentStatusExpired',
  refunded: 'billingAdmin.paymentStatusRefunded',
};

export function PaymentsPage() {
  const { t } = useTranslation();
  const statusLabel = (status: string): string => {
    const key = paymentStatusKey[status];
    return key === undefined ? status : t(key);
  };
  const [tenantInput, setTenantInput] = useState('');
  const [tenantId, setTenantId] = useState('');

  const query = useCursorQuery<PaymentIntentView>({
    key: ['admin', 'payments'],
    path: '/admin/payments',
    query: { tenantId },
    enabled: tenantId !== '',
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('billingAdmin.paymentsTitle')}
        description={t('billingAdmin.paymentsDescription')}
      />

      <Card>
        <DataTableToolbar
          onRefresh={tenantId === '' ? undefined : () => void query.refetch()}
          refreshing={query.isRefetching}
        >
          <form
            className="flex min-w-64 flex-1 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setTenantId(tenantInput.trim());
            }}
          >
            <Input
              value={tenantInput}
              onChange={(event) => setTenantInput(event.target.value)}
              placeholder={t('billingAdmin.tenantFilterPlaceholder')}
              aria-label={t('billingAdmin.tenantFilterLabel')}
              className="max-w-sm font-mono"
            />
            <Button type="submit" variant="outline">
              {t('billingAdmin.apply')}
            </Button>
          </form>
        </DataTableToolbar>

        {tenantId === '' ? (
          <EmptyState
            icon={CreditCard}
            title={t('billingAdmin.tenantPromptTitle')}
            description={t('billingAdmin.tenantPromptDescription')}
          />
        ) : query.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={5} />
          </div>
        ) : query.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(query.error)}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : query.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t('billingAdmin.paymentsEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colProvider')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colPurpose')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colAmount')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colCreditAmount')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colTenant')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {query.rows.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="whitespace-nowrap">
                        <DateTimeText value={row.created_at} />
                      </DataTableCell>
                      <DataTableCell>{row.provider}</DataTableCell>
                      <DataTableCell>
                        <Badge variant="neutral">{row.purpose}</Badge>
                      </DataTableCell>
                      <DataTableCell className="whitespace-nowrap">
                        <span className="font-mono tabular-nums">{row.amount_minor}</span>{' '}
                        <span className="text-muted-foreground">{row.currency}</span>
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.credit_amount} />
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={paymentStatusVariant[row.status] ?? 'neutral'}>
                          {statusLabel(row.status)}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.tenant_id.slice(0, 8)}
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="px-4 pb-4">
              <LoadMore
                count={query.rows.length}
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>
    </PageTransition>
  );
}
