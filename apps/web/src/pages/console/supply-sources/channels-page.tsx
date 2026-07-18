import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, PlugZap, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
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
import { PlusIcon } from '@/components/ui/icons/plus';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const AUTH_SCHEMES = ['bearer', 'x_api_key', 'query', 'ak_sk', 'oauth'] as const;
type AuthScheme = (typeof AUTH_SCHEMES)[number];
type ChannelStatus = 'active' | 'disabled';

interface DialectRef {
  ref: string;
  version: string;
}

interface ChannelRow {
  id: string;
  provider_id: string;
  name: string;
  dialect: DialectRef | null;
  base_url: string | null;
  proxy_ref: string | null;
  region: string | null;
  auth_scheme: AuthScheme;
  tenant_id: string | null;
  route_group_id: string | null;
  tags: string[];
  status: ChannelStatus;
  created_at: string;
  updated_at: string;
}

interface ProviderRow {
  id: string;
  slug: string;
  name: string;
}

interface ChannelFormState {
  providerId: string;
  name: string;
  authScheme: AuthScheme;
  baseUrl: string;
  region: string;
  tags: string;
  routeGroupId: string;
  status: ChannelStatus;
}

interface ChannelWriteBody {
  provider_id?: string;
  name: string;
  auth_scheme: AuthScheme;
  base_url: string | null;
  region: string | null;
  tags: string[];
  route_group_id: string | null;
  status: ChannelStatus;
}

const emptyForm: ChannelFormState = {
  providerId: '',
  name: '',
  authScheme: 'bearer',
  baseUrl: '',
  region: '',
  tags: '',
  routeGroupId: '',
  status: 'active',
};

const channelStatusVariant = { active: 'success', disabled: 'danger' } as const;

const CHANNELS_KEY = ['admin', 'supply', 'channels'] as const;
const PROVIDERS_KEY = ['admin', 'supply', 'providers'] as const;

function toWriteBody(form: ChannelFormState, includeProvider: boolean): ChannelWriteBody {
  const body: ChannelWriteBody = {
    name: form.name.trim(),
    auth_scheme: form.authScheme,
    base_url: form.baseUrl.trim() === '' ? null : form.baseUrl.trim(),
    region: form.region.trim() === '' ? null : form.region.trim(),
    tags: form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
    route_group_id: form.routeGroupId.trim() === '' ? null : form.routeGroupId.trim(),
    status: form.status,
  };
  if (includeProvider) body.provider_id = form.providerId;
  return body;
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const channels = useCursorQuery<ChannelRow>({
    key: CHANNELS_KEY,
    path: '/admin/supply/channels',
  });
  const providers = useCursorQuery<ProviderRow>({
    key: PROVIDERS_KEY,
    path: '/admin/supply/providers',
    limit: 100,
  });

  const providerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers.rows) map.set(provider.id, provider.name);
    return map;
  }, [providers.rows]);

  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelRow | null>(null);
  const [form, setForm] = useState<ChannelFormState>(emptyForm);
  const [deleting, setDeleting] = useState<ChannelRow | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return channels.rows;
    return channels.rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [channels.rows, search]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
  };

  const saveMutation = useMutation({
    mutationFn: (body: ChannelWriteBody) =>
      editing
        ? apiFetch<ChannelRow>(`/admin/supply/channels/${editing.id}`, { method: 'PATCH', body })
        : apiFetch<ChannelRow>('/admin/supply/channels', { method: 'POST', body }),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/admin/supply/channels/${id}`, { method: 'DELETE' }),
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

  const openEdit = (row: ChannelRow) => {
    setEditing(row);
    setForm({
      providerId: row.provider_id,
      name: row.name,
      authScheme: row.auth_scheme,
      baseUrl: row.base_url ?? '',
      region: row.region ?? '',
      tags: row.tags.join(', '),
      routeGroupId: row.route_group_id ?? '',
      status: row.status,
    });
    saveMutation.reset();
    setDialogOpen(true);
  };

  const canSave = form.name.trim() !== '' && (editing !== null || form.providerId !== '');

  return (
    <PageTransition>
      <PageHeader
        title={t('supplySources.channelsTitle')}
        description={t('supplySources.channelsDescription')}
        actions={
          <Button onClick={openCreate}>
            <PlusIcon animateOnHover />
            {t('supplySources.newChannel')}
          </Button>
        }
      />

      <Card>
        <DataTableToolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('supplySources.searchChannels'),
          }}
          onRefresh={() => void channels.refetch()}
          refreshing={channels.isRefetching}
        />
        {channels.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : channels.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(channels.error)}
              onRetry={() => void channels.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={PlugZap}
            title={t('supplySources.channelsEmpty')}
            description={t('supplySources.channelsEmptyDescription')}
            action={
              <Button onClick={openCreate}>
                <PlusIcon animateOnHover />
                {t('supplySources.newChannel')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable className="min-w-[960px]">
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colProvider')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colDialect')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colBaseUrl')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colAuthScheme')}</DataTableHead>
                    <DataTableHead>{t('supplySources.colTags')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => void navigate(`/console/supply/channels/${row.id}`)}
                    >
                      <DataTableCell className="font-medium">
                        <span className="inline-flex items-center gap-2">
                          {row.name}
                          {row.tenant_id !== null ? (
                            <Badge variant="primary">
                              {`${t('supplySources.byok')} · ${row.tenant_id.slice(0, 8)}`}
                            </Badge>
                          ) : null}
                        </span>
                      </DataTableCell>
                      <DataTableCell>
                        {providerNames.get(row.provider_id) ?? row.provider_id.slice(0, 8)}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.dialect ? (
                          `${row.dialect.ref}@${row.dialect.version}`
                        ) : (
                          <span className="font-sans text-muted-foreground">
                            {t('supplySources.dialectInherited')}
                          </span>
                        )}
                      </DataTableCell>
                      <DataTableCell className="max-w-56 truncate font-mono text-sm">
                        {row.base_url ?? '—'}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.auth_scheme}</DataTableCell>
                      <DataTableCell>
                        {row.tags.length === 0 ? (
                          '—'
                        ) : (
                          <span className="inline-flex flex-wrap gap-1">
                            {row.tags.map((tag) => (
                              <Badge key={tag} variant="neutral">
                                {tag}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={channelStatusVariant[row.status]}>
                          {row.status === 'active' ? t('common.active') : t('common.disabled')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.edit')}
                            onClick={(event) => {
                              event.stopPropagation();
                              openEdit(row);
                            }}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.delete')}
                            onClick={(event) => {
                              event.stopPropagation();
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
                count={channels.rows.length}
                hasMore={channels.hasNextPage}
                loading={channels.isFetchingNextPage}
                onLoadMore={() => void channels.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('supplySources.editChannel') : t('supplySources.newChannel')}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? t('supplySources.providerLockedHint')
                : t('supplySources.channelsDescription')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave || saveMutation.isPending) return;
              saveMutation.mutate(toWriteBody(form, editing === null));
            }}
          >
            <FormField label={t('supplySources.fieldProvider')}>
              {() => (
                <Select
                  value={form.providerId}
                  onValueChange={(value) => setForm((f) => ({ ...f, providerId: value }))}
                  disabled={editing !== null}
                >
                  <SelectTrigger aria-label={t('supplySources.fieldProvider')}>
                    <SelectValue placeholder={t('supplySources.selectProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.rows.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label={t('common.name')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.name}
                  onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                />
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('supplySources.fieldAuthScheme')}>
                {() => (
                  <Select
                    value={form.authScheme}
                    onValueChange={(value) =>
                      setForm((f) => ({ ...f, authScheme: value as AuthScheme }))
                    }
                  >
                    <SelectTrigger aria-label={t('supplySources.fieldAuthScheme')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUTH_SCHEMES.map((scheme) => (
                        <SelectItem key={scheme} value={scheme}>
                          {scheme}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField label={t('common.status')}>
                {() => (
                  <Select
                    value={form.status}
                    onValueChange={(value) =>
                      setForm((f) => ({ ...f, status: value as ChannelStatus }))
                    }
                  >
                    <SelectTrigger aria-label={t('common.status')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">{t('common.active')}</SelectItem>
                      <SelectItem value="disabled">{t('common.disabled')}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>
            <FormField
              label={t('supplySources.fieldBaseUrl')}
              hint={t('supplySources.baseUrlHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.baseUrl}
                  onChange={(event) => setForm((f) => ({ ...f, baseUrl: event.target.value }))}
                />
              )}
            </FormField>
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
              <FormField
                label={t('supplySources.fieldRouteGroup')}
                hint={t('supplySources.routeGroupHint')}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={form.routeGroupId}
                    onChange={(event) =>
                      setForm((f) => ({ ...f, routeGroupId: event.target.value }))
                    }
                  />
                )}
              </FormField>
            </div>
            <FormField label={t('supplySources.fieldTags')} hint={t('supplySources.tagsHint')}>
              {(id) => (
                <Input
                  id={id}
                  value={form.tags}
                  onChange={(event) => setForm((f) => ({ ...f, tags: event.target.value }))}
                />
              )}
            </FormField>
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
        title={t('supplySources.deleteChannelTitle')}
        description={t('supplySources.deleteChannelDescription')}
        confirmLabel={t('common.delete')}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleting) deleteMutation.mutate(deleting.id);
        }}
      />
    </PageTransition>
  );
}
