import type { BreakerView } from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
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
  DataTablePagination,
  DataTableRow,
  DataTableSortHead,
  DataTableToolbar,
} from '@/components/ui/data-display';
import { useDataTable } from '@/hooks/use-data-table';

const stateVariant = { closed: 'success', open: 'danger', half_open: 'warning' } as const;
const stateLabelKey = {
  closed: 'routing.stateClosed',
  open: 'routing.stateOpen',
  half_open: 'routing.stateHalfOpen',
} as const;

export function BreakersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [resetting, setResetting] = useState<BreakerView | null>(null);

  const query = useQuery({
    queryKey: ['admin', 'breakers'],
    queryFn: () => apiFetch<BreakerView[]>('/admin/breakers'),
  });

  const filtered = useMemo(() => {
    const rows = query.data ?? [];
    const keyword = search.trim().toLowerCase();
    if (keyword === '') return rows;
    return rows.filter((row) =>
      [row.channel_name ?? '', row.channel_id, row.resource_id ?? '', row.model]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }, [query.data, search]);

  const table = useDataTable(filtered, {
    pageSize: 20,
    sortValues: {
      channel: (row) => row.channel_name ?? row.channel_id,
      model: (row) => row.model,
      state: (row) => row.state,
      failure_rate: (row) => row.failure_rate,
      trip_count: (row) => row.trip_count,
      opened_at: (row) => row.opened_at,
      cooldown_until: (row) => row.cooldown_until,
    },
    initialSort: { key: 'opened_at', direction: 'desc' },
  });

  const reset = useMutation({
    mutationFn: (row: BreakerView) =>
      apiFetch<undefined>(
        `/admin/breakers/${row.channel_id}/${encodeURIComponent(row.model)}/reset`,
        {
          method: 'POST',
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'breakers'] });
      setResetting(null);
    },
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('routing.breakersTitle')}
        description={t('routing.breakersDescription')}
      />
      {reset.isError ? (
        <ApiErrorNotice error={toApiStateError(reset.error)} className="mb-4" />
      ) : null}
      <Card>
        <DataTableToolbar
          search={{ value: search, onChange: setSearch, placeholder: t('routing.breakersSearch') }}
          onRefresh={() => void query.refetch()}
          refreshing={query.isRefetching}
        />
        {query.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : query.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(query.error)}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={t('routing.breakersEmptyTitle')}
            description={t('routing.breakersEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableSortHead
                      direction={table.directionFor('channel')}
                      onToggle={() => table.toggleSort('channel')}
                    >
                      {t('routing.colChannel')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('model')}
                      onToggle={() => table.toggleSort('model')}
                    >
                      {t('routing.colModel')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('state')}
                      onToggle={() => table.toggleSort('state')}
                    >
                      {t('common.status')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('failure_rate')}
                      onToggle={() => table.toggleSort('failure_rate')}
                    >
                      {t('routing.colFailureRate')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('trip_count')}
                      onToggle={() => table.toggleSort('trip_count')}
                    >
                      {t('routing.colTrips')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('opened_at')}
                      onToggle={() => table.toggleSort('opened_at')}
                    >
                      {t('routing.colOpenedAt')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('cooldown_until')}
                      onToggle={() => table.toggleSort('cooldown_until')}
                    >
                      {t('routing.colCooldownUntil')}
                    </DataTableSortHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {table.rows.map((row) => (
                    <DataTableRow key={`${row.channel_id}-${row.model}`}>
                      <DataTableCell>
                        <p className="font-medium">
                          {row.channel_name ?? row.channel_id.slice(0, 8)}
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {row.resource_id === null ? '' : `${row.resource_id} · `}
                          {row.channel_id.slice(0, 8)}
                        </p>
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.model}</DataTableCell>
                      <DataTableCell>
                        <Badge variant={stateVariant[row.state]}>
                          {t(stateLabelKey[row.state])}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.failure_rate === null ? '—' : `${row.failure_rate.toFixed(1)}%`}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.trip_count}
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.opened_at}
                          className="text-xs text-muted-foreground"
                        />
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.cooldown_until}
                          className="text-xs text-muted-foreground"
                        />
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('routing.reset')}
                          onClick={() => setResetting(row)}
                        >
                          <RotateCcw />
                        </Button>
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <DataTablePagination
              page={table.page}
              pageCount={table.pageCount}
              total={table.total}
              pageSize={table.pageSize}
              onPageChange={table.setPage}
              onPageSizeChange={table.setPageSize}
            />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(next) => {
          if (!next) setResetting(null);
        }}
        title={t('routing.resetTitle')}
        description={
          resetting
            ? t('routing.resetConfirm', {
                channel: resetting.channel_name ?? resetting.channel_id.slice(0, 8),
                model: resetting.model,
              })
            : ''
        }
        confirmLabel={t('routing.reset')}
        destructive={false}
        pending={reset.isPending}
        onConfirm={() => {
          if (resetting) reset.mutate(resetting);
        }}
      />
    </PageTransition>
  );
}
