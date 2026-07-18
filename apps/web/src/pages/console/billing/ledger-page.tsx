import type { LedgerView } from '@actionow/contracts';
import { ScrollText } from 'lucide-react';
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

function shortId(id: string): string {
  return id.slice(0, 8);
}

function DeltaCell({ value }: { value: string }) {
  if (value.startsWith('-')) return <MoneyText value={value} className="text-danger" />;
  return (
    <span className="text-success">
      <span className="font-mono tabular-nums">+</span>
      <MoneyText value={value} />
    </span>
  );
}

export function LedgerPage() {
  const { t } = useTranslation();
  const [tenantInput, setTenantInput] = useState('');
  const [tenantId, setTenantId] = useState('');

  const query = useCursorQuery<LedgerView>({
    key: ['admin', 'ledger'],
    path: '/admin/ledger',
    query: { tenantId },
    enabled: tenantId !== '',
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('billingAdmin.ledgerTitle')}
        description={t('billingAdmin.ledgerDescription')}
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
            icon={ScrollText}
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
            {t('billingAdmin.ledgerEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('billingAdmin.colTime')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colType')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colDelta')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colBalanceAfter')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colTenant')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colAccount')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colSubject')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {query.rows.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="whitespace-nowrap">
                        <DateTimeText value={row.created_at} />
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant="neutral">{row.type}</Badge>
                      </DataTableCell>
                      <DataTableCell>
                        <DeltaCell value={row.credits_delta} />
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.balance_after} />
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {shortId(row.tenant_id)}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {shortId(row.account_id)}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.subject_id === null ? '—' : shortId(row.subject_id)}
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
