import type {
  GrantSupplyModelBody,
  Model,
  ModelGrantView,
  ModelStatus,
  ModelVisibility,
  PriceCard,
  Provider,
  SupplyPriceCardFromOfficialBody,
  TenantView,
  UpdateSupplyModelBody,
} from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/copy-button';
import { DateTimeText } from '@/components/common/date-time-text';
import { DetailList } from '@/components/common/detail-list';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
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
  Skeleton,
} from '@/components/ui/data-display';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const modelStatusVariant = {
  draft: 'neutral',
  active: 'success',
  deprecated: 'warning',
  disabled: 'danger',
} as const;

const MODEL_STATUS_OPTIONS: readonly ModelStatus[] = ['draft', 'active', 'deprecated', 'disabled'];
const VISIBILITY_OPTIONS: readonly ModelVisibility[] = ['public', 'granted'];

export function ModelDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const modelId = id ?? '';
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<ModelStatus>('draft');
  const [visibility, setVisibility] = useState<ModelVisibility>('public');
  const [fallbackIds, setFallbackIds] = useState('');
  const [mintOpen, setMintOpen] = useState(false);
  const [mintProvider, setMintProvider] = useState('');
  const [grantTenant, setGrantTenant] = useState('');
  const [revokeTenant, setRevokeTenant] = useState<string | null>(null);

  const model = useQuery({
    queryKey: ['admin', 'supply', 'models', modelId],
    queryFn: () => apiFetch<Model>(`/admin/supply/models/${modelId}`),
    enabled: modelId !== '',
  });

  const priceCardId = model.data?.price_card_id ?? null;
  const priceCard = useQuery({
    queryKey: ['admin', 'supply', 'price-cards', priceCardId],
    queryFn: () => apiFetch<PriceCard>(`/admin/supply/price-cards/${priceCardId ?? ''}`),
    enabled: priceCardId !== null,
  });

  const granted = model.data?.visibility === 'granted';
  const grants = useCursorQuery<ModelGrantView>({
    key: ['admin', 'supply', 'models', modelId, 'grants'],
    path: `/admin/supply/models/${modelId}/grants`,
    enabled: modelId !== '' && granted,
  });
  const tenants = useCursorQuery<TenantView>({
    key: ['admin', 'tenants'],
    path: '/admin/tenants',
    limit: 200,
    enabled: granted,
  });
  const providers = useCursorQuery<Provider>({
    key: ['admin', 'supply', 'providers'],
    path: '/admin/supply/providers',
    limit: 200,
    enabled: mintOpen,
  });

  const tenantById = useMemo(
    () => new Map(tenants.rows.map((row) => [row.id, row])),
    [tenants.rows],
  );

  const updateModel = useMutation({
    mutationFn: (body: UpdateSupplyModelBody) =>
      apiFetch<Model>(`/admin/supply/models/${modelId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'models'] });
      setEditOpen(false);
    },
  });

  const mintPriceCard = useMutation({
    mutationFn: (body: SupplyPriceCardFromOfficialBody) =>
      apiFetch<PriceCard>(`/admin/supply/models/${modelId}/price-card/from-official`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'models'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'price-cards'] });
      setMintOpen(false);
    },
  });

  const addGrant = useMutation({
    mutationFn: (body: GrantSupplyModelBody) =>
      apiFetch<{ ok: true }>(`/admin/supply/models/${modelId}/grants`, { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'supply', 'models', modelId, 'grants'],
      });
      setGrantTenant('');
    },
  });

  const revokeGrant = useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch<undefined>(`/admin/supply/models/${modelId}/grants/${tenantId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'supply', 'models', modelId, 'grants'],
      });
      setRevokeTenant(null);
    },
  });

  const openEdit = () => {
    const current = model.data;
    if (!current) return;
    setDisplayName(current.display_name);
    setStatus(current.status);
    setVisibility(current.visibility);
    setFallbackIds(current.fallback_model_ids.join('\n'));
    updateModel.reset();
    setEditOpen(true);
  };

  const submitEdit = () => {
    if (displayName.trim() === '') return;
    updateModel.mutate({
      display_name: displayName.trim(),
      status,
      visibility,
      fallback_model_ids: fallbackIds
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    });
  };

  const openMint = () => {
    setMintProvider('');
    mintPriceCard.reset();
    setMintOpen(true);
  };

  const current = model.data;

  return (
    <PageTransition>
      <PageHeader
        title={current?.display_name ?? t('supplyModels.modelDetailTitle')}
        description={t('supplyModels.modelDetailDescription')}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/console/supply/models">
                <ArrowLeft />
                {t('supplyModels.backToModels')}
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={openEdit} disabled={!current}>
              <Pencil />
              {t('common.edit')}
            </Button>
          </>
        }
      />

      {model.isLoading ? (
        <ResourceLoading rows={6} />
      ) : model.isError ? (
        <ApiErrorNotice error={toApiStateError(model.error)} onRetry={() => void model.refetch()} />
      ) : current ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold">{t('supplyModels.baseInfoTitle')}</h2>
            <DetailList
              items={[
                {
                  label: t('common.id'),
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <span className="font-mono text-xs">{current.id}</span>
                      <CopyButton value={current.id} />
                    </span>
                  ),
                },
                {
                  label: t('supplyModels.colName'),
                  value: <span className="font-mono">{current.name}</span>,
                },
                { label: t('supplyModels.colDisplayName'), value: current.display_name },
                {
                  label: t('supplyModels.colModality'),
                  value: <Badge variant="neutral">{current.modality}</Badge>,
                },
                {
                  label: t('common.status'),
                  value: (
                    <Badge variant={modelStatusVariant[current.status]}>
                      {t(`supplyModels.modelStatus.${current.status}`)}
                    </Badge>
                  ),
                },
                {
                  label: t('supplyModels.colVisibility'),
                  value: t(`supplyModels.visibility.${current.visibility}`),
                },
                {
                  label: t('supplyModels.fieldMaxRunTime'),
                  value:
                    current.max_run_time_seconds === null ? (
                      '—'
                    ) : (
                      <span className="font-mono tabular-nums">
                        {current.max_run_time_seconds}s
                      </span>
                    ),
                },
                {
                  label: t('supplyModels.fieldFallbackIds'),
                  value:
                    current.fallback_model_ids.length === 0 ? (
                      '—'
                    ) : (
                      <span className="font-mono text-xs">
                        {current.fallback_model_ids.join(', ')}
                      </span>
                    ),
                },
                {
                  label: t('common.createdAt'),
                  value: <DateTimeText value={current.created_at} />,
                },
                {
                  label: t('common.updatedAt'),
                  value: <DateTimeText value={current.updated_at} />,
                },
              ]}
            />
          </Card>

          <div className="grid content-start gap-4">
            <Card className="p-5">
              <div className="mb-3 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">{t('supplyModels.pricingTitle')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('supplyModels.pricingDescription')}
                  </p>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/console/supply/price-cards">{t('supplyModels.viewPriceCards')}</Link>
                </Button>
              </div>
              {current.price_card_id === null ? (
                <div className="flex flex-col items-start gap-3 py-2">
                  <Badge variant="warning">{t('supplyModels.needsPricing')}</Badge>
                  <p className="text-sm text-muted-foreground">{t('supplyModels.noPriceCard')}</p>
                </div>
              ) : priceCard.isLoading ? (
                <div className="grid gap-2 py-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-5 w-56" />
                </div>
              ) : priceCard.isError ? (
                <ApiErrorNotice
                  error={toApiStateError(priceCard.error)}
                  onRetry={() => void priceCard.refetch()}
                />
              ) : priceCard.data ? (
                <DetailList
                  items={[
                    { label: t('common.name'), value: priceCard.data.name },
                    {
                      label: t('supplyModels.cardMethod'),
                      value: <span className="font-mono text-sm">{priceCard.data.method}</span>,
                    },
                    { label: t('supplyModels.cardUnit'), value: priceCard.data.unit },
                    {
                      label: t('supplyModels.cardCurrency'),
                      value: <span className="font-mono text-sm">{priceCard.data.currency}</span>,
                    },
                    {
                      label: t('supplyModels.cardVersion'),
                      value: (
                        <span className="font-mono tabular-nums">v{priceCard.data.version}</span>
                      ),
                    },
                    {
                      label: t('supplyModels.cardEffectiveAt'),
                      value: <DateTimeText value={priceCard.data.effective_at} />,
                    },
                  ]}
                />
              ) : null}
              <div className="mt-4">
                <Button variant="outline" size="sm" onClick={openMint}>
                  {t('supplyModels.mintFromOfficial')}
                </Button>
              </div>
            </Card>

            <Card className="p-5">
              <h2 className="text-sm font-semibold">{t('supplyModels.operationsTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('supplyModels.operationsDescription')}
              </p>
              <div className="mt-4 grid gap-3">
                {current.operations.map((op) => (
                  <div key={op.operation} className="rounded-xl bg-surface-subtle p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-mono text-sm font-medium">{op.operation}</p>
                      {op.slow ? <Badge variant="warning">{t('supplyModels.opSlow')}</Badge> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {op.paradigms.map((paradigm) => (
                        <Badge key={paradigm} variant="neutral" className="font-mono">
                          {paradigm}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('supplyModels.opParamsCount', { count: op.params.length })}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {granted ? (
            <Card className="p-5 lg:col-span-2">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">{t('supplyModels.grantsTitle')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('supplyModels.grantsDescription')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Select value={grantTenant} onValueChange={setGrantTenant}>
                    <SelectTrigger className="w-56" aria-label={t('supplyModels.colTenant')}>
                      <SelectValue placeholder={t('supplyModels.selectTenantPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {tenants.rows.map((tenant) => (
                        <SelectItem key={tenant.id} value={tenant.id}>
                          {tenant.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={grantTenant === '' || addGrant.isPending}
                    onClick={() => addGrant.mutate({ tenant_id: grantTenant })}
                  >
                    <Plus />
                    {t('supplyModels.addGrant')}
                  </Button>
                </div>
              </div>
              {addGrant.isError ? (
                <p className="mb-3 text-sm text-danger">
                  {toApiStateError(addGrant.error).message}
                </p>
              ) : null}
              {grants.isLoading ? (
                <ResourceLoading rows={2} />
              ) : grants.isError ? (
                <ApiErrorNotice
                  error={toApiStateError(grants.error)}
                  onRetry={() => void grants.refetch()}
                />
              ) : grants.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t('supplyModels.grantsEmpty')}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <DataTable className="min-w-full">
                      <DataTableHeader>
                        <DataTableRow>
                          <DataTableHead>{t('supplyModels.colTenant')}</DataTableHead>
                          <DataTableHead>{t('supplyModels.colGrantedAt')}</DataTableHead>
                          <DataTableHead className="text-right">
                            {t('common.actions')}
                          </DataTableHead>
                        </DataTableRow>
                      </DataTableHeader>
                      <DataTableBody>
                        {grants.rows.map((grant) => (
                          <DataTableRow key={grant.id}>
                            <DataTableCell>
                              <p className="text-sm">
                                {tenantById.get(grant.tenant_id)?.name ??
                                  grant.tenant_id.slice(0, 8)}
                              </p>
                              <p className="font-mono text-xs text-muted-foreground">
                                {grant.tenant_id}
                              </p>
                            </DataTableCell>
                            <DataTableCell>
                              <DateTimeText value={grant.created_at} className="text-xs" />
                            </DataTableCell>
                            <DataTableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('supplyModels.revoke')}
                                onClick={() => {
                                  revokeGrant.reset();
                                  setRevokeTenant(grant.tenant_id);
                                }}
                              >
                                <Trash2 />
                              </Button>
                            </DataTableCell>
                          </DataTableRow>
                        ))}
                      </DataTableBody>
                    </DataTable>
                  </div>
                  <LoadMore
                    count={grants.rows.length}
                    hasMore={grants.hasNextPage}
                    loading={grants.isFetchingNextPage}
                    onLoadMore={() => void grants.fetchNextPage()}
                  />
                </>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.editModelTitle')}</DialogTitle>
            <DialogDescription>{t('supplyModels.editModelDescription')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitEdit();
            }}
          >
            <FormField label={t('supplyModels.fieldDisplayName')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="off"
                  required
                />
              )}
            </FormField>
            <FormField label={t('common.status')}>
              {(fieldId) => (
                <Select value={status} onValueChange={(value) => setStatus(value as ModelStatus)}>
                  <SelectTrigger id={fieldId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`supplyModels.modelStatus.${option}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label={t('supplyModels.fieldVisibility')}>
              {(fieldId) => (
                <Select
                  value={visibility}
                  onValueChange={(value) => setVisibility(value as ModelVisibility)}
                >
                  <SelectTrigger id={fieldId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VISIBILITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`supplyModels.visibility.${option}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField
              label={t('supplyModels.fieldFallbackIds')}
              hint={t('supplyModels.fieldFallbackIdsHint')}
            >
              {(fieldId) => (
                <Textarea
                  id={fieldId}
                  value={fallbackIds}
                  onChange={(event) => setFallbackIds(event.target.value)}
                  className="min-h-20 font-mono text-xs"
                />
              )}
            </FormField>
            {updateModel.isError ? (
              <p className="text-sm text-danger">{toApiStateError(updateModel.error).message}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditOpen(false)}
                disabled={updateModel.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={updateModel.isPending || displayName.trim() === ''}>
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mintOpen} onOpenChange={setMintOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.mintDialogTitle')}</DialogTitle>
            <DialogDescription>{t('supplyModels.mintDialogDescription')}</DialogDescription>
          </DialogHeader>
          <FormField label={t('supplyModels.fieldProvider')}>
            {(fieldId) => (
              <Select value={mintProvider} onValueChange={setMintProvider}>
                <SelectTrigger id={fieldId} disabled={providers.isLoading}>
                  <SelectValue placeholder={t('supplyModels.selectProviderPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {providers.rows.map((provider) => (
                    <SelectItem key={provider.id} value={provider.slug}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          {providers.isError ? (
            <ApiErrorNotice
              error={toApiStateError(providers.error)}
              onRetry={() => void providers.refetch()}
            />
          ) : null}
          {mintPriceCard.isError ? (
            <p className="text-sm text-danger">{toApiStateError(mintPriceCard.error).message}</p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMintOpen(false)}
              disabled={mintPriceCard.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={mintProvider === '' || mintPriceCard.isPending}
              onClick={() => mintPriceCard.mutate({ provider: mintProvider })}
            >
              {t('supplyModels.mintConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeTenant !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTenant(null);
        }}
        title={t('supplyModels.revokeGrantTitle')}
        description={t('supplyModels.revokeGrantDescription')}
        confirmLabel={t('supplyModels.revoke')}
        pending={revokeGrant.isPending}
        onConfirm={() => {
          if (revokeTenant !== null) revokeGrant.mutate(revokeTenant);
        }}
      />
    </PageTransition>
  );
}
