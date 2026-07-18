import type {
  Channel,
  EnableSupplyOfferingResponse,
  GoldenProbeCheck,
  Model,
  Offering,
  OfferingStatus,
  ProbeSupplyOfferingResponse,
  UpdateSupplyOfferingBody,
} from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Layers, Pencil, Play, Power, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const offeringStatusVariant = {
  enabled: 'success',
  probing: 'warning',
  draft: 'neutral',
  disabled: 'danger',
} as const;

const OFFERING_STATUS_OPTIONS: readonly OfferingStatus[] = [
  'draft',
  'probing',
  'enabled',
  'disabled',
];

function ProbeCheckLine({ label, check }: { label: string; check: GoldenProbeCheck }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-sm [overflow-wrap:anywhere]">{check.message}</p>
      </div>
      <Badge variant={check.ok ? 'success' : 'danger'} className="shrink-0">
        {check.ok ? t('supplyModels.probePass') : t('supplyModels.probeFail')}
      </Badge>
    </div>
  );
}

export function OfferingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [modelFilter, setModelFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const [probeTarget, setProbeTarget] = useState<Offering | null>(null);
  const [enableTarget, setEnableTarget] = useState<Offering | null>(null);
  const [disableTarget, setDisableTarget] = useState<Offering | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Offering | null>(null);
  const [editTarget, setEditTarget] = useState<Offering | null>(null);
  const [editUpstreamName, setEditUpstreamName] = useState('');
  const [editTier, setEditTier] = useState('0');
  const [editWeight, setEditWeight] = useState('1');
  const [editTimeout, setEditTimeout] = useState('');

  const offerings = useCursorQuery<Offering>({
    key: ['admin', 'supply', 'offerings'],
    path: '/admin/supply/offerings',
    query: {
      model_id: modelFilter === 'all' ? undefined : modelFilter,
      channel_id: channelFilter === 'all' ? undefined : channelFilter,
      status: statusFilter === 'all' ? undefined : statusFilter,
    },
  });
  const models = useCursorQuery<Model>({
    key: ['admin', 'supply', 'models'],
    path: '/admin/supply/models',
    limit: 200,
  });
  const channels = useCursorQuery<Channel>({
    key: ['admin', 'supply', 'channels'],
    path: '/admin/supply/channels',
    limit: 200,
  });

  const modelById = useMemo(() => new Map(models.rows.map((row) => [row.id, row])), [models.rows]);
  const channelById = useMemo(
    () => new Map(channels.rows.map((row) => [row.id, row])),
    [channels.rows],
  );

  const invalidateOfferings = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'offerings'] });
  };

  const probe = useMutation({
    mutationFn: (offeringId: string) =>
      apiFetch<ProbeSupplyOfferingResponse>(`/admin/supply/offerings/${offeringId}/probe`, {
        method: 'POST',
      }),
  });

  const enable = useMutation({
    mutationFn: (offeringId: string) =>
      apiFetch<EnableSupplyOfferingResponse>(`/admin/supply/offerings/${offeringId}/enable`, {
        method: 'POST',
      }),
    onSuccess: invalidateOfferings,
  });

  const disableOffering = useMutation({
    mutationFn: (offeringId: string) =>
      apiFetch<Offering>(`/admin/supply/offerings/${offeringId}`, {
        method: 'PATCH',
        body: { status: 'disabled' } satisfies UpdateSupplyOfferingBody,
      }),
    onSuccess: () => {
      invalidateOfferings();
      setDisableTarget(null);
    },
  });

  const editOffering = useMutation({
    mutationFn: ({ offeringId, body }: { offeringId: string; body: UpdateSupplyOfferingBody }) =>
      apiFetch<Offering>(`/admin/supply/offerings/${offeringId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      invalidateOfferings();
      setEditTarget(null);
    },
  });

  const deleteOffering = useMutation({
    mutationFn: (offeringId: string) =>
      apiFetch<undefined>(`/admin/supply/offerings/${offeringId}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateOfferings();
      setDeleteTarget(null);
    },
  });

  const startProbe = (offering: Offering) => {
    probe.reset();
    setProbeTarget(offering);
    probe.mutate(offering.id);
  };

  const startEnable = (offering: Offering) => {
    enable.reset();
    setEnableTarget(offering);
    enable.mutate(offering.id);
  };

  const openEdit = (offering: Offering) => {
    setEditUpstreamName(offering.upstream_model_name);
    setEditTier(String(offering.tier));
    setEditWeight(String(offering.weight));
    setEditTimeout(
      offering.timeout_budget_seconds === null ? '' : String(offering.timeout_budget_seconds),
    );
    editOffering.reset();
    setEditTarget(offering);
  };

  const submitEdit = () => {
    if (!editTarget || editUpstreamName.trim() === '') return;
    const tier = Number.parseInt(editTier, 10);
    const weight = Number.parseInt(editWeight, 10);
    const timeoutRaw = editTimeout.trim();
    const timeout = timeoutRaw === '' ? null : Number.parseInt(timeoutRaw, 10);
    editOffering.mutate({
      offeringId: editTarget.id,
      body: {
        upstream_model_name: editUpstreamName.trim(),
        tier: Number.isNaN(tier) ? editTarget.tier : tier,
        weight: Number.isNaN(weight) || weight < 0 ? editTarget.weight : weight,
        timeout_budget_seconds:
          timeout !== null && (Number.isNaN(timeout) || timeout <= 0)
            ? editTarget.timeout_budget_seconds
            : timeout,
      },
    });
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('supplyModels.offeringsTitle')}
        description={t('supplyModels.offeringsDescription')}
      />

      {offerings.isLoading ? (
        <ResourceLoading rows={5} />
      ) : offerings.isError ? (
        <ApiErrorNotice
          error={toApiStateError(offerings.error)}
          onRetry={() => void offerings.refetch()}
        />
      ) : (
        <Card>
          <DataTableToolbar
            onRefresh={() => void offerings.refetch()}
            refreshing={offerings.isRefetching}
          >
            <Select value={modelFilter} onValueChange={setModelFilter}>
              <SelectTrigger className="w-44" aria-label={t('supplyModels.filterModel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('supplyModels.filterAllModels')}</SelectItem>
                {models.rows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={channelFilter} onValueChange={setChannelFilter}>
              <SelectTrigger className="w-44" aria-label={t('supplyModels.filterChannel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('supplyModels.filterAllChannels')}</SelectItem>
                {channels.rows.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36" aria-label={t('supplyModels.filterStatus')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('supplyModels.filterAllStatuses')}</SelectItem>
                {OFFERING_STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`supplyModels.offeringStatus.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DataTableToolbar>
          {offerings.rows.length === 0 ? (
            <EmptyState
              icon={Layers}
              title={t('supplyModels.emptyOfferingsTitle')}
              description={t('supplyModels.emptyOfferingsDescription')}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <DataTable className="min-w-[920px]">
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableHead>{t('supplyModels.colModel')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colChannel')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colUpstreamName')}</DataTableHead>
                      <DataTableHead>{t('common.status')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colTier')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colWeight')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colCostCard')}</DataTableHead>
                      <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {offerings.rows.map((row) => {
                      const rowModel = modelById.get(row.model_id);
                      const rowChannel = channelById.get(row.channel_id);
                      return (
                        <DataTableRow key={row.id}>
                          <DataTableCell>
                            <p className="text-sm">
                              {rowModel?.display_name ?? row.model_id.slice(0, 8)}
                            </p>
                            {rowModel ? (
                              <p className="font-mono text-xs text-muted-foreground">
                                {rowModel.name}
                              </p>
                            ) : null}
                          </DataTableCell>
                          <DataTableCell>
                            {rowChannel?.name ?? row.channel_id.slice(0, 8)}
                          </DataTableCell>
                          <DataTableCell className="font-mono text-sm">
                            {row.upstream_model_name}
                          </DataTableCell>
                          <DataTableCell>
                            <Badge variant={offeringStatusVariant[row.status]}>
                              {t(`supplyModels.offeringStatus.${row.status}`)}
                            </Badge>
                          </DataTableCell>
                          <DataTableCell className="font-mono tabular-nums">
                            {row.tier}
                          </DataTableCell>
                          <DataTableCell className="font-mono tabular-nums">
                            {row.weight}
                          </DataTableCell>
                          <DataTableCell>
                            {row.cost_price_card_id === null ? (
                              <Badge variant="warning">{t('supplyModels.costCardMissing')}</Badge>
                            ) : (
                              <Badge variant="neutral">{t('supplyModels.costCardSet')}</Badge>
                            )}
                          </DataTableCell>
                          <DataTableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('supplyModels.actionProbe')}
                                disabled={probe.isPending}
                                onClick={() => startProbe(row)}
                              >
                                <Activity />
                              </Button>
                              {row.status === 'enabled' ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t('common.disable')}
                                  onClick={() => {
                                    disableOffering.reset();
                                    setDisableTarget(row);
                                  }}
                                >
                                  <Power />
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t('common.enable')}
                                  disabled={enable.isPending}
                                  onClick={() => startEnable(row)}
                                >
                                  <Play />
                                </Button>
                              )}
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
                                  deleteOffering.reset();
                                  setDeleteTarget(row);
                                }}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </DataTableCell>
                        </DataTableRow>
                      );
                    })}
                  </DataTableBody>
                </DataTable>
              </div>
              <div className="px-4 pb-3">
                <LoadMore
                  count={offerings.rows.length}
                  hasMore={offerings.hasNextPage}
                  loading={offerings.isFetchingNextPage}
                  onLoadMore={() => void offerings.fetchNextPage()}
                />
              </div>
            </>
          )}
        </Card>
      )}

      <Dialog
        open={probeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setProbeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.probeDialogTitle')}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {probeTarget?.upstream_model_name ?? ''}
            </DialogDescription>
          </DialogHeader>
          {probe.isPending ? (
            <p className="animate-pulse py-4 text-sm text-muted-foreground">
              {t('supplyModels.probePending')}
            </p>
          ) : probe.isError ? (
            <ApiErrorNotice error={toApiStateError(probe.error)} />
          ) : probe.data ? (
            probe.data.status === 'completed' ? (
              <div className="divide-y divide-border/60">
                <ProbeCheckLine
                  label={t('supplyModels.probeConnectivity')}
                  check={probe.data.result.connectivity}
                />
                <ProbeCheckLine
                  label={t('supplyModels.probeFunctional')}
                  check={probe.data.result.functional}
                />
                <div className="py-2">
                  <p className="font-mono text-xs tabular-nums text-muted-foreground">
                    {t('supplyModels.probeElapsed', { ms: probe.data.result.elapsed_ms })}
                  </p>
                  {probe.data.result.sample?.text !== undefined ||
                  probe.data.result.sample?.url !== undefined ? (
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground">
                        {t('supplyModels.probeSample')}
                      </p>
                      <p className="mt-1 rounded-lg bg-surface-subtle p-3 font-mono text-xs [overflow-wrap:anywhere]">
                        {probe.data.result.sample.text ?? probe.data.result.sample.url}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="grid gap-2 py-2">
                <Badge variant="warning" className="w-fit">
                  {t('supplyModels.probeRejected')}
                </Badge>
                <p className="text-sm">{probe.data.rejection.message}</p>
                {probe.data.rejection.retry_after_seconds !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    {t('supplyModels.probeRetryAfter', {
                      seconds: probe.data.rejection.retry_after_seconds,
                    })}
                  </p>
                ) : null}
              </div>
            )
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setProbeTarget(null)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={enableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEnableTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.enableDialogTitle')}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {enableTarget?.upstream_model_name ?? ''}
            </DialogDescription>
          </DialogHeader>
          {enable.isPending ? (
            <p className="animate-pulse py-4 text-sm text-muted-foreground">
              {t('supplyModels.enablePending')}
            </p>
          ) : enable.isError ? (
            <ApiErrorNotice error={toApiStateError(enable.error)} />
          ) : enable.data ? (
            enable.data.enabled ? (
              <div className="flex items-center gap-2 py-2">
                <Badge variant="success">{t('supplyModels.enableSuccess')}</Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {enable.data.offering_status}
                </span>
              </div>
            ) : (
              <div className="grid gap-3 py-2">
                <Badge variant="danger" className="w-fit">
                  {t('supplyModels.enableFailed')}
                </Badge>
                <ul className="divide-y divide-border/60">
                  {enable.data.violations.map((violation, index) => (
                    <li key={`${violation.gate}-${String(index)}`} className="py-2">
                      <p className="font-mono text-xs text-muted-foreground">
                        {violation.gate}
                        {violation.param !== undefined ? ` · ${violation.param}` : ''}
                        {violation.operation !== undefined ? ` · ${violation.operation}` : ''}
                      </p>
                      <p className="mt-0.5 text-sm [overflow-wrap:anywhere]">{violation.message}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnableTarget(null)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.editOfferingTitle')}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitEdit();
            }}
          >
            <FormField label={t('supplyModels.fieldUpstreamName')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  value={editUpstreamName}
                  onChange={(event) => setEditUpstreamName(event.target.value)}
                  className="font-mono"
                  autoComplete="off"
                  required
                />
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('supplyModels.fieldTier')}>
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    type="number"
                    value={editTier}
                    onChange={(event) => setEditTier(event.target.value)}
                  />
                )}
              </FormField>
              <FormField label={t('supplyModels.fieldWeight')}>
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    type="number"
                    min={0}
                    value={editWeight}
                    onChange={(event) => setEditWeight(event.target.value)}
                  />
                )}
              </FormField>
            </div>
            <FormField
              label={t('supplyModels.fieldTimeoutBudget')}
              hint={t('supplyModels.fieldTimeoutBudgetHint')}
            >
              {(fieldId) => (
                <Input
                  id={fieldId}
                  type="number"
                  min={1}
                  value={editTimeout}
                  onChange={(event) => setEditTimeout(event.target.value)}
                />
              )}
            </FormField>
            {editOffering.isError ? (
              <p className="text-sm text-danger">{toApiStateError(editOffering.error).message}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditTarget(null)}
                disabled={editOffering.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={editOffering.isPending || editUpstreamName.trim() === ''}
              >
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        title={t('supplyModels.disableConfirmTitle')}
        description={t('supplyModels.disableConfirmDescription')}
        confirmLabel={t('common.disable')}
        destructive={false}
        pending={disableOffering.isPending}
        onConfirm={() => {
          if (disableTarget !== null) disableOffering.mutate(disableTarget.id);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('supplyModels.deleteOfferingTitle')}
        description={t('supplyModels.deleteOfferingDescription')}
        confirmLabel={t('common.delete')}
        pending={deleteOffering.isPending}
        onConfirm={() => {
          if (deleteTarget !== null) deleteOffering.mutate(deleteTarget.id);
        }}
      />
    </PageTransition>
  );
}
