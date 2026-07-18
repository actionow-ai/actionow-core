import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Factory, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
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
import { PlusIcon } from '@/components/ui/icons/plus';
import { Input } from '@/components/ui/input';

interface DialectRef {
  ref: string;
  version: string;
}

interface ProviderRow {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  default_dialect: DialectRef;
  callback_verification: Record<string, unknown> | null;
  default_fault_policy_id: string | null;
  region: string | null;
  created_at: string;
  updated_at: string;
}

interface ProviderFormBody {
  slug: string;
  name: string;
  icon: string | null;
  default_dialect: DialectRef;
  region: string | null;
}

interface ProviderFormState {
  slug: string;
  name: string;
  icon: string;
  region: string;
  dialectRef: string;
  dialectVersion: string;
}

const emptyForm: ProviderFormState = {
  slug: '',
  name: '',
  icon: '',
  region: '',
  dialectRef: '',
  dialectVersion: '',
};

const PROVIDERS_KEY = ['admin', 'supply', 'providers'] as const;

function toBody(form: ProviderFormState): ProviderFormBody {
  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    icon: form.icon.trim() === '' ? null : form.icon.trim(),
    default_dialect: { ref: form.dialectRef.trim(), version: form.dialectVersion.trim() },
    region: form.region.trim() === '' ? null : form.region.trim(),
  };
}

export function ProvidersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const providers = useCursorQuery<ProviderRow>({
    key: PROVIDERS_KEY,
    path: '/admin/supply/providers',
  });

  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  const [form, setForm] = useState<ProviderFormState>(emptyForm);
  const [deleting, setDeleting] = useState<ProviderRow | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return providers.rows;
    return providers.rows.filter(
      (row) => row.name.toLowerCase().includes(needle) || row.slug.toLowerCase().includes(needle),
    );
  }, [providers.rows, search]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
  };

  const saveMutation = useMutation({
    mutationFn: (body: ProviderFormBody) =>
      editing
        ? apiFetch<ProviderRow>(`/admin/supply/providers/${editing.id}`, {
            method: 'PATCH',
            body,
          })
        : apiFetch<ProviderRow>('/admin/supply/providers', { method: 'POST', body }),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/admin/supply/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    saveMutation.reset();
    setDialogOpen(true);
  };

  const openEdit = (row: ProviderRow) => {
    setEditing(row);
    setForm({
      slug: row.slug,
      name: row.name,
      icon: row.icon ?? '',
      region: row.region ?? '',
      dialectRef: row.default_dialect.ref,
      dialectVersion: row.default_dialect.version,
    });
    saveMutation.reset();
    setDialogOpen(true);
  };

  const canSave =
    form.slug.trim() !== '' &&
    form.name.trim() !== '' &&
    form.dialectRef.trim() !== '' &&
    form.dialectVersion.trim() !== '';

  return (
    <PageTransition>
      <PageHeader
        title={t('supplySources.providersTitle')}
        description={t('supplySources.providersDescription')}
        actions={
          <Button onClick={openCreate}>
            <PlusIcon animateOnHover />
            {t('supplySources.newProvider')}
          </Button>
        }
      />

      <Card>
        <DataTableToolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('supplySources.searchProviders'),
          }}
          onRefresh={() => void providers.refetch()}
          refreshing={providers.isRefetching}
        />
        {providers.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : providers.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(providers.error)}
              onRetry={() => void providers.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Factory}
            title={t('supplySources.providersEmpty')}
            description={t('supplySources.providersEmptyDescription')}
            action={
              <Button onClick={openCreate}>
                <PlusIcon animateOnHover />
                {t('supplySources.newProvider')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colSlug')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colRegion')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colDialect')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="font-medium">{row.name}</DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.slug}</DataTableCell>
                      <DataTableCell>{row.region ?? '—'}</DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {`${row.default_dialect.ref}@${row.default_dialect.version}`}
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText value={row.created_at} className="text-sm" />
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.edit')}
                            onClick={() => openEdit(row)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.delete')}
                            onClick={() => {
                              deleteMutation.reset();
                              setDeleting(row);
                            }}
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
            <div className="px-4 pb-4">
              <LoadMore
                count={providers.rows.length}
                hasMore={providers.hasNextPage}
                loading={providers.isFetchingNextPage}
                onLoadMore={() => void providers.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('supplySources.editProvider') : t('supplySources.newProvider')}
            </DialogTitle>
            <DialogDescription>{t('supplySources.providersDescription')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave || saveMutation.isPending) return;
              saveMutation.mutate(toBody(form));
            }}
          >
            <FormField label={t('common.name')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.name}
                  onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                />
              )}
            </FormField>
            <FormField label={t('supplySources.fieldSlug')} hint={t('supplySources.slugHint')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.slug}
                  onChange={(event) => setForm((f) => ({ ...f, slug: event.target.value }))}
                />
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('supplySources.fieldDialectRef')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.dialectRef}
                    onChange={(event) => setForm((f) => ({ ...f, dialectRef: event.target.value }))}
                  />
                )}
              </FormField>
              <FormField label={t('supplySources.fieldDialectVersion')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.dialectVersion}
                    onChange={(event) =>
                      setForm((f) => ({ ...f, dialectVersion: event.target.value }))
                    }
                  />
                )}
              </FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('supplySources.fieldRegion')} hint={t('common.optional')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.region}
                    onChange={(event) => setForm((f) => ({ ...f, region: event.target.value }))}
                  />
                )}
              </FormField>
              <FormField label={t('supplySources.fieldIcon')} hint={t('supplySources.iconHint')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.icon}
                    onChange={(event) => setForm((f) => ({ ...f, icon: event.target.value }))}
                  />
                )}
              </FormField>
            </div>
            {saveMutation.isError ? (
              <p className="text-sm text-danger">{toApiStateError(saveMutation.error).message}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={saveMutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!canSave || saveMutation.isPending}>
                {editing ? t('common.save') : t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('supplySources.deleteProviderTitle')}
        description={t('supplySources.deleteProviderDescription')}
        confirmLabel={t('common.delete')}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleting) deleteMutation.mutate(deleting.id);
        }}
      />
    </PageTransition>
  );
}
