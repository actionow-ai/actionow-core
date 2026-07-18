import type { RelayTraceView } from '@actionow/contracts';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { DetailList } from '@/components/common/detail-list';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/components/radix/sheet';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ErrorsFilter = 'all' | 'errors';
type StreamFilter = 'all' | 'stream' | 'sync';

function useDebounced(value: string, delay = 400): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Pretty-print a captured body when it parses as JSON; fall back to the raw text. */
function prettyBody(body: string | null): string | null {
  if (body === null || body === '') return null;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function isFailure(row: RelayTraceView): boolean {
  return row.error !== null || (row.response_status !== null && row.response_status >= 400);
}

function JsonBlock({
  title,
  content,
  empty,
}: {
  title: string;
  content: string | null;
  empty: string;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {content === null ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <pre className="max-h-72 overflow-auto rounded-xl bg-surface-subtle/60 p-3 font-mono text-xs break-all whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}

export function RelayTracesPage() {
  const { t } = useTranslation();

  const [providerType, setProviderType] = useState('');
  const [routeTag, setRouteTag] = useState('');
  const [errorsFilter, setErrorsFilter] = useState<ErrorsFilter>('all');
  const [streamFilter, setStreamFilter] = useState<StreamFilter>('all');
  const [selected, setSelected] = useState<RelayTraceView | null>(null);

  const debouncedProviderType = useDebounced(providerType).trim();
  const debouncedRouteTag = useDebounced(routeTag).trim();

  const query = useCursorQuery<RelayTraceView>({
    key: ['admin', 'relay-traces', 'list'],
    path: '/admin/relay-traces',
    query: {
      providerType: debouncedProviderType === '' ? undefined : debouncedProviderType,
      routeTag: debouncedRouteTag === '' ? undefined : debouncedRouteTag,
      errorsOnly: errorsFilter === 'errors' ? 'true' : undefined,
      isStream: streamFilter === 'all' ? undefined : streamFilter === 'stream' ? 'true' : 'false',
    },
  });

  const selectedHeaders = selected?.request_headers
    ? JSON.stringify(selected.request_headers, null, 2)
    : null;

  return (
    <PageTransition>
      <PageHeader title={t('opsPages.tracesTitle')} description={t('opsPages.tracesDescription')} />

      <Card className="overflow-hidden">
        <DataTableToolbar onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
          <Input
            value={providerType}
            onChange={(event) => setProviderType(event.target.value)}
            placeholder={t('opsPages.filterProviderType')}
            aria-label={t('opsPages.filterProviderType')}
            className="w-40 font-mono"
          />
          <Input
            value={routeTag}
            onChange={(event) => setRouteTag(event.target.value)}
            placeholder={t('opsPages.filterRouteTag')}
            aria-label={t('opsPages.filterRouteTag')}
            className="w-36 font-mono"
          />
          <Select
            value={errorsFilter}
            onValueChange={(value) => setErrorsFilter(value as ErrorsFilter)}
          >
            <SelectTrigger className="w-32" aria-label={t('opsPages.filterErrors')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('opsPages.errorsAll')}</SelectItem>
              <SelectItem value="errors">{t('opsPages.errorsOnly')}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={streamFilter}
            onValueChange={(value) => setStreamFilter(value as StreamFilter)}
          >
            <SelectTrigger className="w-36" aria-label={t('opsPages.filterStream')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('opsPages.streamAll')}</SelectItem>
              <SelectItem value="stream">{t('opsPages.streamOnly')}</SelectItem>
              <SelectItem value="sync">{t('opsPages.streamNon')}</SelectItem>
            </SelectContent>
          </Select>
        </DataTableToolbar>

        {query.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={6} />
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
            {t('opsPages.tracesEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable className="min-w-[960px]">
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('opsPages.colTime')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colProvider')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colUrl')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colUpstreamStatus')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colStream')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colLatency')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colTruncated')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colRouteTag')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {query.rows.map((row) => (
                    <DataTableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(row)}
                    >
                      <DataTableCell className="whitespace-nowrap">
                        <DateTimeText value={row.created_at} className="text-xs" />
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.provider_type ?? '—'}
                      </DataTableCell>
                      <DataTableCell>
                        <span className="block max-w-56 truncate font-mono text-xs" title={row.url}>
                          {row.url}
                        </span>
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={isFailure(row) ? 'danger' : 'success'}>
                          {row.response_status === null
                            ? t('opsPages.statusError')
                            : String(row.response_status)}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        {row.is_stream ? (
                          <Badge variant="neutral">{t('opsPages.streamBadge')}</Badge>
                        ) : (
                          '—'
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.latency_ms === null ? '—' : `${String(row.latency_ms)} ms`}
                      </DataTableCell>
                      <DataTableCell>
                        {row.truncated ? (
                          <Badge variant="warning">{t('opsPages.truncatedBadge')}</Badge>
                        ) : (
                          '—'
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.route_tag ?? '—'}
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

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:w-[620px] sm:max-w-[90vw]">
          <SheetHeader>
            <SheetTitle>{t('opsPages.traceDetailTitle')}</SheetTitle>
          </SheetHeader>
          {selected ? (
            <div className="space-y-5 px-4 pb-6">
              <DetailList
                items={[
                  {
                    label: t('common.id'),
                    value: <span className="font-mono text-xs">{selected.id}</span>,
                  },
                  {
                    label: t('opsPages.colTime'),
                    value: <DateTimeText value={selected.created_at} />,
                  },
                  {
                    label: t('opsPages.colProvider'),
                    value: (
                      <span className="font-mono text-xs">{selected.provider_type ?? '—'}</span>
                    ),
                  },
                  {
                    label: t('opsPages.filterTenantId'),
                    value: <span className="font-mono text-xs">{selected.tenant_id ?? '—'}</span>,
                  },
                  {
                    label: t('opsPages.colUrl'),
                    value: (
                      <span className="font-mono text-xs">
                        {selected.method} {selected.url}
                      </span>
                    ),
                  },
                  {
                    label: t('opsPages.colUpstreamStatus'),
                    value: (
                      <span className="font-mono text-xs">
                        {selected.response_status === null ? '—' : String(selected.response_status)}
                      </span>
                    ),
                  },
                  {
                    label: t('opsPages.colLatency'),
                    value: (
                      <span className="font-mono text-xs">
                        {selected.latency_ms === null ? '—' : `${String(selected.latency_ms)} ms`}
                      </span>
                    ),
                  },
                  {
                    label: t('opsPages.colStream'),
                    value: selected.is_stream ? (
                      <Badge variant="neutral">{t('opsPages.streamBadge')}</Badge>
                    ) : (
                      '—'
                    ),
                  },
                  {
                    label: t('opsPages.colTruncated'),
                    value: selected.truncated ? (
                      <Badge variant="warning">{t('opsPages.truncatedBadge')}</Badge>
                    ) : (
                      '—'
                    ),
                  },
                  {
                    label: t('opsPages.colRouteTag'),
                    value: <span className="font-mono text-xs">{selected.route_tag ?? '—'}</span>,
                  },
                ]}
              />
              {selected.error !== null ? (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">{t('opsPages.errorLabel')}</h3>
                  <p className="rounded-xl bg-danger/10 p-3 font-mono text-xs break-all whitespace-pre-wrap text-danger">
                    {selected.error}
                  </p>
                </div>
              ) : null}
              <JsonBlock
                title={t('opsPages.requestHeaders')}
                content={selectedHeaders}
                empty={t('opsPages.bodyEmpty')}
              />
              <JsonBlock
                title={t('opsPages.requestBody')}
                content={prettyBody(selected.request_body)}
                empty={t('opsPages.bodyEmpty')}
              />
              <JsonBlock
                title={t('opsPages.responseBody')}
                content={prettyBody(selected.response_body)}
                empty={t('opsPages.bodyEmpty')}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </PageTransition>
  );
}
