import type { CreateProxyBody, ProxyView, UpdateProxyBody } from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Globe, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
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
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ProxyFormState {
  name: string;
  url: string;
  status: string;
  description: string;
}

function proxyFormFrom(proxy: ProxyView | null): ProxyFormState {
  return {
    name: proxy?.name ?? '',
    url: '',
    status: proxy?.status === 'disabled' ? 'disabled' : 'active',
    description: proxy?.description ?? '',
  };
}

function ProxyFormDialog({
  open,
  onOpenChange,
  proxy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proxy: ProxyView | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProxyFormState>(() => proxyFormFrom(proxy));

  useEffect(() => {
    if (open) setForm(proxyFormFrom(proxy));
  }, [open, proxy]);

  const mutation = useMutation({
    mutationFn: () => {
      const description = form.description.trim();
      const url = form.url.trim();
      const status = form.status === 'disabled' ? ('disabled' as const) : ('active' as const);
      if (proxy) {
        const body: UpdateProxyBody = {
          name: form.name.trim(),
          ...(url === '' ? {} : { url }),
          status,
          description: description === '' ? null : description,
        };
        return apiFetch<ProxyView>(`/admin/proxies/${proxy.id}`, { method: 'PATCH', body });
      }
      const body: CreateProxyBody = {
        name: form.name.trim(),
        url,
        status,
        ...(description === '' ? {} : { description }),
      };
      return apiFetch<ProxyView>('/admin/proxies', { method: 'POST', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
      onOpenChange(false);
    },
  });

  const canSave =
    form.name.trim() !== '' && (proxy !== null || form.url.trim() !== '') && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{proxy ? t('routing.editProxy') : t('routing.createProxy')}</DialogTitle>
        </DialogHeader>
        {mutation.isError ? <ApiErrorNotice error={toApiStateError(mutation.error)} /> : null}
        <div className="grid gap-4">
          <FormField label={t('common.name')}>
            {(id) => (
              <Input
                id={id}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            )}
          </FormField>
          <FormField
            label={t('routing.fieldUrl')}
            hint={proxy ? t('routing.urlHintEdit') : t('routing.urlHintCreate')}
          >
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                placeholder="socks5://host:port"
                autoComplete="off"
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t('common.status')}>
            {(id) => (
              <Select
                value={form.status}
                onValueChange={(value) => setForm({ ...form, status: value })}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('common.active')}</SelectItem>
                  <SelectItem value="disabled">{t('common.disabled')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label={t('common.description')}>
            {(id) => (
              <Textarea
                id={id}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSave}>
            {proxy ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProxiesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyView | null>(null);
  const [deleting, setDeleting] = useState<ProxyView | null>(null);

  const query = useCursorQuery<ProxyView>({ key: ['admin', 'proxies'], path: '/admin/proxies' });

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (keyword === '') return query.rows;
    return query.rows.filter(
      (row) => row.name.toLowerCase().includes(keyword) || row.host.toLowerCase().includes(keyword),
    );
  }, [query.rows, search]);

  const probe = useMutation({
    mutationFn: (id: string) =>
      apiFetch<ProxyView>(`/admin/proxies/${id}/probe`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => apiFetch<undefined>(`/admin/proxies/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'proxies'] });
      setDeleting(null);
    },
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('routing.proxiesTitle')}
        description={t('routing.proxiesDescription')}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('routing.createProxy')}
          </Button>
        }
      />
      {probe.isError ? (
        <ApiErrorNotice error={toApiStateError(probe.error)} className="mb-4" />
      ) : null}
      {removeMutation.isError ? (
        <ApiErrorNotice error={toApiStateError(removeMutation.error)} className="mb-4" />
      ) : null}
      <Card>
        <DataTableToolbar
          search={{ value: search, onChange: setSearch, placeholder: t('routing.proxiesSearch') }}
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
            icon={Globe}
            title={t('routing.proxiesEmptyTitle')}
            description={t('routing.proxiesEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('routing.colScheme')}</DataTableHead>
                    <DataTableHead>{t('routing.colHost')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('routing.colHealthy')}</DataTableHead>
                    <DataTableHead>{t('routing.colLatency')}</DataTableHead>
                    <DataTableHead>{t('routing.colLastChecked')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>
                        <p className="font-medium">{row.name}</p>
                        {row.description === null ? null : (
                          <p className="mt-0.5 max-w-56 truncate text-xs text-muted-foreground">
                            {row.description}
                          </p>
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-xs">{row.scheme}</DataTableCell>
                      <DataTableCell className="font-mono text-xs">{row.host}</DataTableCell>
                      <DataTableCell>
                        <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
                          {row.status === 'active' ? t('common.active') : t('common.disabled')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        {row.healthy === null ? (
                          <Badge variant="neutral">{t('routing.healthyUnknown')}</Badge>
                        ) : row.healthy ? (
                          <Badge variant="success">{t('routing.healthyOk')}</Badge>
                        ) : (
                          <Badge variant="danger" title={row.last_error ?? undefined}>
                            {t('routing.healthyFail')}
                          </Badge>
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.last_latency_ms === null ? '—' : `${String(row.last_latency_ms)} ms`}
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.last_checked_at}
                          className="text-xs text-muted-foreground"
                        />
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.probe')}
                            disabled={probe.isPending && probe.variables === row.id}
                            onClick={() => probe.mutate(row.id)}
                          >
                            <Activity
                              className={
                                probe.isPending && probe.variables === row.id
                                  ? 'animate-pulse'
                                  : undefined
                              }
                            />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.editProxy')}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.deleteProxy')}
                            onClick={() => setDeleting(row)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="border-t px-4 pb-3">
              <LoadMore
                count={filtered.length}
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <ProxyFormDialog
        open={createOpen || editing !== null}
        proxy={editing}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={t('routing.deleteProxy')}
        description={deleting ? t('routing.deleteProxyConfirm', { name: deleting.name }) : ''}
        confirmLabel={t('common.delete')}
        pending={removeMutation.isPending}
        onConfirm={() => {
          if (deleting) removeMutation.mutate(deleting.id);
        }}
      />
    </PageTransition>
  );
}
