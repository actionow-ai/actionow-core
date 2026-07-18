import type { AuditLogView } from '@actionow/contracts';
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

type ActorFilter = 'all' | 'operator' | 'member' | 'system';

function useDebounced(value: string, delay = 400): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function shortId(id: string | null): string {
  return id === null ? '—' : id.slice(0, 8);
}

function metaText(meta: unknown): string | null {
  if (meta === null || meta === undefined) return null;
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return null;
  }
}

export function AuditLogPage() {
  const { t } = useTranslation();

  const [action, setAction] = useState('');
  const [actorType, setActorType] = useState<ActorFilter>('all');
  const [tenantId, setTenantId] = useState('');
  const [targetType, setTargetType] = useState('');
  const [selected, setSelected] = useState<AuditLogView | null>(null);

  const debouncedAction = useDebounced(action).trim();
  const debouncedTenantId = useDebounced(tenantId).trim();
  const debouncedTargetType = useDebounced(targetType).trim();

  const query = useCursorQuery<AuditLogView>({
    key: ['admin', 'audit-log', 'list'],
    path: '/admin/audit-log',
    query: {
      action: debouncedAction === '' ? undefined : debouncedAction,
      actorType: actorType === 'all' ? undefined : actorType,
      tenantId: debouncedTenantId === '' ? undefined : debouncedTenantId,
      targetType: debouncedTargetType === '' ? undefined : debouncedTargetType,
    },
  });

  const actorLabel = (type: string) =>
    type === 'operator'
      ? t('opsPages.actorOperator')
      : type === 'member'
        ? t('opsPages.actorMember')
        : type === 'system'
          ? t('opsPages.actorSystem')
          : type;

  const selectedMeta = selected ? metaText(selected.meta) : null;

  return (
    <PageTransition>
      <PageHeader title={t('opsPages.auditTitle')} description={t('opsPages.auditDescription')} />

      <Card className="overflow-hidden">
        <DataTableToolbar onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
          <Input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            placeholder={t('opsPages.filterAction')}
            aria-label={t('opsPages.filterAction')}
            className="w-44 font-mono"
          />
          <Select value={actorType} onValueChange={(value) => setActorType(value as ActorFilter)}>
            <SelectTrigger className="w-36" aria-label={t('opsPages.filterActorType')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('opsPages.actorAll')}</SelectItem>
              <SelectItem value="operator">{t('opsPages.actorOperator')}</SelectItem>
              <SelectItem value="member">{t('opsPages.actorMember')}</SelectItem>
              <SelectItem value="system">{t('opsPages.actorSystem')}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            placeholder={t('opsPages.filterTenantId')}
            aria-label={t('opsPages.filterTenantId')}
            className="w-44 font-mono"
          />
          <Input
            value={targetType}
            onChange={(event) => setTargetType(event.target.value)}
            placeholder={t('opsPages.filterTargetType')}
            aria-label={t('opsPages.filterTargetType')}
            className="w-40 font-mono"
          />
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
            {t('opsPages.auditEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('opsPages.colTime')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colActor')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colAction')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colTarget')}</DataTableHead>
                    <DataTableHead>{t('opsPages.colRequestId')}</DataTableHead>
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
                      <DataTableCell>
                        <span className="text-xs text-muted-foreground">
                          {actorLabel(row.actor_type)}
                        </span>
                        <span className="ml-2 font-mono text-sm">{shortId(row.actor_id)}</span>
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.action}</DataTableCell>
                      <DataTableCell>
                        <span className="text-xs text-muted-foreground">{row.target_type}</span>
                        <span className="ml-2 font-mono text-sm">{shortId(row.target_id)}</span>
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {shortId(row.request_id)}
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
        <SheetContent className="w-full overflow-y-auto sm:w-[560px] sm:max-w-[90vw]">
          <SheetHeader>
            <SheetTitle>{t('opsPages.auditDetailTitle')}</SheetTitle>
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
                    label: t('opsPages.filterActorType'),
                    value: actorLabel(selected.actor_type),
                  },
                  {
                    label: t('opsPages.colActor'),
                    value: <span className="font-mono text-xs">{selected.actor_id ?? '—'}</span>,
                  },
                  {
                    label: t('opsPages.filterTenantId'),
                    value: <span className="font-mono text-xs">{selected.tenant_id ?? '—'}</span>,
                  },
                  {
                    label: t('opsPages.colSubject'),
                    value: <span className="font-mono text-xs">{selected.subject_id ?? '—'}</span>,
                  },
                  {
                    label: t('opsPages.colAction'),
                    value: <span className="font-mono text-xs">{selected.action}</span>,
                  },
                  {
                    label: t('opsPages.filterTargetType'),
                    value: selected.target_type,
                  },
                  {
                    label: t('opsPages.colTarget'),
                    value: <span className="font-mono text-xs">{selected.target_id ?? '—'}</span>,
                  },
                  {
                    label: t('opsPages.colRequestId'),
                    value: <span className="font-mono text-xs">{selected.request_id ?? '—'}</span>,
                  },
                ]}
              />
              <div>
                <h3 className="mb-2 text-sm font-semibold">{t('opsPages.metaTitle')}</h3>
                {selectedMeta === null ? (
                  <p className="text-sm text-muted-foreground">{t('opsPages.metaEmpty')}</p>
                ) : (
                  <pre className="max-h-96 overflow-auto rounded-xl bg-surface-subtle/60 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                    {selectedMeta}
                  </pre>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </PageTransition>
  );
}
