import type { ConsoleModelView } from '@actionow/contracts';
import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, type PageOf, toApiStateError } from '@/api/client';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
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

function formatContext(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString('en-US');
}

export function AppModelsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['console', 'models'],
    queryFn: () => apiFetch<PageOf<ConsoleModelView>>('/console/models'),
  });

  const models = useMemo(() => query.data?.data ?? [], [query.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return models;
    return models.filter((model) =>
      [model.name, model.display, model.modality, model.maker ?? '', ...model.tags].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [models, search]);

  const table = useDataTable(filtered, {
    pageSize: 10,
    sortValues: {
      name: (model) => model.name,
      display: (model) => model.display,
      modality: (model) => model.modality,
      maker: (model) => model.maker,
      context: (model) => model.context_length,
    },
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantCore.models.title')}
        description={t('tenantCore.models.description')}
      />

      <Card>
        <DataTableToolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('tenantCore.models.searchPlaceholder'),
          }}
          onRefresh={() => void query.refetch()}
          refreshing={query.isRefetching}
        />
        {query.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : query.isError ? (
          <ApiErrorNotice
            error={toApiStateError(query.error)}
            onRetry={() => void query.refetch()}
            className="m-4"
          />
        ) : models.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={t('tenantCore.models.empty')}
            description={t('tenantCore.models.emptyDescription')}
          />
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t('tenantCore.models.emptyFiltered')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableSortHead
                      direction={table.directionFor('name')}
                      onToggle={() => table.toggleSort('name')}
                    >
                      {t('tenantCore.models.colName')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('display')}
                      onToggle={() => table.toggleSort('display')}
                    >
                      {t('tenantCore.models.colDisplay')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('modality')}
                      onToggle={() => table.toggleSort('modality')}
                    >
                      {t('tenantCore.models.colModality')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('maker')}
                      onToggle={() => table.toggleSort('maker')}
                    >
                      {t('tenantCore.models.colMaker')}
                    </DataTableSortHead>
                    <DataTableSortHead
                      direction={table.directionFor('context')}
                      onToggle={() => table.toggleSort('context')}
                    >
                      {t('tenantCore.models.colContext')}
                    </DataTableSortHead>
                    <DataTableHead>{t('tenantCore.models.colTags')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.models.colVisibility')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {table.rows.map((model) => (
                    <DataTableRow key={model.name}>
                      <DataTableCell className="font-mono text-sm">{model.name}</DataTableCell>
                      <DataTableCell>{model.display}</DataTableCell>
                      <DataTableCell>
                        <Badge variant="neutral">{model.modality}</Badge>
                      </DataTableCell>
                      <DataTableCell>{model.maker ?? '—'}</DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {formatContext(model.context_length)}
                      </DataTableCell>
                      <DataTableCell>
                        {model.tags.length === 0 ? (
                          <span className="text-sm text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            {model.tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} variant="neutral">
                                {tag}
                              </Badge>
                            ))}
                            {model.tags.length > 3 ? (
                              <span className="text-xs text-muted-foreground">
                                +{String(model.tags.length - 3)}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={model.visibility === 'granted' ? 'primary' : 'neutral'}>
                          {model.visibility === 'granted'
                            ? t('tenantCore.models.visibilityGranted')
                            : model.visibility === 'public'
                              ? t('tenantCore.models.visibilityPublic')
                              : model.visibility}
                        </Badge>
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
    </PageTransition>
  );
}
