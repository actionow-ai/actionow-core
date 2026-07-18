import type {
  CreateFaultPolicyBody,
  FaultPolicyView,
  UpdateFaultPolicyBody,
} from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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

function intFrom(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function intOrNull(value: string): number | null {
  return intFrom(value) ?? null;
}

function fmtMs(value: number | null): string {
  return value === null ? '—' : String(value);
}

interface PolicyFormState {
  name: string;
  status: string;
  description: string;
  fastFail: string;
  retryCount: string;
  backoffType: string;
  backoffMs: string;
  connectTimeoutMs: string;
  ttftTimeoutMs: string;
  totalTimeoutMs: string;
  idleTimeoutMs: string;
  breakerEnabled: string;
  breakerWindowMs: string;
  breakerMinVolume: string;
  breakerFailureRatePct: string;
  breakerHalfOpenTrial: string;
  breakerHalfOpenSuccesses: string;
  breakerOpenCooldownMs: string;
  breakerOpenCooldownCapMs: string;
}

function policyFormFrom(policy: FaultPolicyView | null): PolicyFormState {
  const num = (value: number | null | undefined): string =>
    value === null || value === undefined ? '' : String(value);
  return {
    name: policy?.name ?? '',
    status: policy?.status === 'disabled' ? 'disabled' : 'active',
    description: policy?.description ?? '',
    fastFail: policy?.fast_fail ? 'true' : 'false',
    retryCount: policy ? String(policy.retry_count) : '0',
    backoffType: policy?.backoff_type === 'exponential' ? 'exponential' : 'fixed',
    backoffMs: policy ? String(policy.backoff_ms) : '0',
    connectTimeoutMs: num(policy?.connect_timeout_ms),
    ttftTimeoutMs: num(policy?.ttft_timeout_ms),
    totalTimeoutMs: num(policy?.total_timeout_ms),
    idleTimeoutMs: num(policy?.idle_timeout_ms),
    breakerEnabled: policy === null || policy.breaker_enabled ? 'true' : 'false',
    breakerWindowMs: num(policy?.breaker_window_ms),
    breakerMinVolume: num(policy?.breaker_min_volume),
    breakerFailureRatePct: num(policy?.breaker_failure_rate_pct),
    breakerHalfOpenTrial: num(policy?.breaker_half_open_trial),
    breakerHalfOpenSuccesses: num(policy?.breaker_half_open_successes),
    breakerOpenCooldownMs: num(policy?.breaker_open_cooldown_ms),
    breakerOpenCooldownCapMs: num(policy?.breaker_open_cooldown_cap_ms),
  };
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <FormField label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

function PolicyFormDialog({
  open,
  onOpenChange,
  policy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: FaultPolicyView | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PolicyFormState>(() => policyFormFrom(policy));

  useEffect(() => {
    if (open) setForm(policyFormFrom(policy));
  }, [open, policy]);

  const set = (field: keyof PolicyFormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const mutation = useMutation({
    mutationFn: () => {
      const description = form.description.trim();
      const base = {
        name: form.name.trim(),
        fastFail: form.fastFail === 'true',
        retryCount: intFrom(form.retryCount),
        backoffType:
          form.backoffType === 'exponential' ? ('exponential' as const) : ('fixed' as const),
        backoffMs: intFrom(form.backoffMs),
        breakerEnabled: form.breakerEnabled === 'true',
        breakerWindowMs: intFrom(form.breakerWindowMs),
        breakerMinVolume: intFrom(form.breakerMinVolume),
        breakerFailureRatePct: intFrom(form.breakerFailureRatePct),
        breakerHalfOpenTrial: intFrom(form.breakerHalfOpenTrial),
        breakerHalfOpenSuccesses: intFrom(form.breakerHalfOpenSuccesses),
        breakerOpenCooldownMs: intFrom(form.breakerOpenCooldownMs),
        breakerOpenCooldownCapMs: intFrom(form.breakerOpenCooldownCapMs),
        status: form.status === 'disabled' ? ('disabled' as const) : ('active' as const),
      };
      if (policy) {
        const body: UpdateFaultPolicyBody = {
          ...base,
          connectTimeoutMs: intOrNull(form.connectTimeoutMs),
          ttftTimeoutMs: intOrNull(form.ttftTimeoutMs),
          totalTimeoutMs: intOrNull(form.totalTimeoutMs),
          idleTimeoutMs: intOrNull(form.idleTimeoutMs),
          description: description === '' ? null : description,
        };
        return apiFetch<FaultPolicyView>(`/admin/fault-policies/${policy.id}`, {
          method: 'PATCH',
          body,
        });
      }
      const body: CreateFaultPolicyBody = {
        ...base,
        connectTimeoutMs: intFrom(form.connectTimeoutMs),
        ttftTimeoutMs: intFrom(form.ttftTimeoutMs),
        totalTimeoutMs: intFrom(form.totalTimeoutMs),
        idleTimeoutMs: intFrom(form.idleTimeoutMs),
        ...(description === '' ? {} : { description }),
      };
      return apiFetch<FaultPolicyView>('/admin/fault-policies', { method: 'POST', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'fault-policies'] });
      onOpenChange(false);
    },
  });

  const canSave = form.name.trim() !== '' && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{policy ? t('routing.editPolicy') : t('routing.createPolicy')}</DialogTitle>
        </DialogHeader>
        {mutation.isError ? <ApiErrorNotice error={toApiStateError(mutation.error)} /> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('common.name')}>
            {(id) => (
              <Input
                id={id}
                value={form.name}
                onChange={(event) => set('name')(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('common.status')}>
            {(id) => (
              <Select value={form.status} onValueChange={set('status')}>
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
          <FormField label={t('common.description')} className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                value={form.description}
                onChange={(event) => set('description')(event.target.value)}
              />
            )}
          </FormField>
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t('routing.sectionRetry')}</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <FormField label={t('routing.fieldFastFail')} hint={t('routing.fastFailHint')}>
              {(id) => (
                <Select value={form.fastFail} onValueChange={set('fastFail')}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">{t('routing.toggleOff')}</SelectItem>
                    <SelectItem value="true">{t('routing.toggleOn')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <NumberField
              label={t('routing.fieldRetryCount')}
              value={form.retryCount}
              onChange={set('retryCount')}
            />
            <FormField label={t('routing.fieldBackoffType')}>
              {(id) => (
                <Select value={form.backoffType} onValueChange={set('backoffType')}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">{t('routing.backoffFixed')}</SelectItem>
                    <SelectItem value="exponential">{t('routing.backoffExponential')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <NumberField
              label={t('routing.fieldBackoffMs')}
              value={form.backoffMs}
              onChange={set('backoffMs')}
            />
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t('routing.sectionTimeouts')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('routing.timeoutHint')}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <NumberField
              label={t('routing.fieldConnectTimeout')}
              value={form.connectTimeoutMs}
              onChange={set('connectTimeoutMs')}
            />
            <NumberField
              label={t('routing.fieldTtftTimeout')}
              value={form.ttftTimeoutMs}
              onChange={set('ttftTimeoutMs')}
            />
            <NumberField
              label={t('routing.fieldTotalTimeout')}
              value={form.totalTimeoutMs}
              onChange={set('totalTimeoutMs')}
            />
            <NumberField
              label={t('routing.fieldIdleTimeout')}
              value={form.idleTimeoutMs}
              onChange={set('idleTimeoutMs')}
            />
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t('routing.sectionBreaker')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('routing.breakerHint')}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <FormField label={t('routing.fieldBreakerEnabled')}>
              {(id) => (
                <Select value={form.breakerEnabled} onValueChange={set('breakerEnabled')}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">{t('routing.toggleOn')}</SelectItem>
                    <SelectItem value="false">{t('routing.toggleOff')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <NumberField
              label={t('routing.fieldBreakerWindow')}
              value={form.breakerWindowMs}
              onChange={set('breakerWindowMs')}
            />
            <NumberField
              label={t('routing.fieldBreakerMinVolume')}
              value={form.breakerMinVolume}
              onChange={set('breakerMinVolume')}
            />
            <NumberField
              label={t('routing.fieldBreakerFailureRate')}
              value={form.breakerFailureRatePct}
              onChange={set('breakerFailureRatePct')}
            />
            <NumberField
              label={t('routing.fieldBreakerHalfOpenTrial')}
              value={form.breakerHalfOpenTrial}
              onChange={set('breakerHalfOpenTrial')}
            />
            <NumberField
              label={t('routing.fieldBreakerHalfOpenSuccesses')}
              value={form.breakerHalfOpenSuccesses}
              onChange={set('breakerHalfOpenSuccesses')}
            />
            <NumberField
              label={t('routing.fieldBreakerCooldown')}
              value={form.breakerOpenCooldownMs}
              onChange={set('breakerOpenCooldownMs')}
            />
            <NumberField
              label={t('routing.fieldBreakerCooldownCap')}
              value={form.breakerOpenCooldownCapMs}
              onChange={set('breakerOpenCooldownCapMs')}
            />
          </div>
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
            {policy ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FaultPoliciesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<FaultPolicyView | null>(null);
  const [deleting, setDeleting] = useState<FaultPolicyView | null>(null);

  const query = useCursorQuery<FaultPolicyView>({
    key: ['admin', 'fault-policies'],
    path: '/admin/fault-policies',
  });

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (keyword === '') return query.rows;
    return query.rows.filter((row) => row.name.toLowerCase().includes(keyword));
  }, [query.rows, search]);

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<undefined>(`/admin/fault-policies/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'fault-policies'] });
      setDeleting(null);
    },
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('routing.faultTitle')}
        description={t('routing.faultDescription')}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('routing.createPolicy')}
          </Button>
        }
      />
      {removeMutation.isError ? (
        <ApiErrorNotice error={toApiStateError(removeMutation.error)} className="mb-4" />
      ) : null}
      <Card>
        <DataTableToolbar
          search={{ value: search, onChange: setSearch, placeholder: t('routing.faultSearch') }}
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
            icon={ShieldAlert}
            title={t('routing.faultEmptyTitle')}
            description={t('routing.faultEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('routing.colRetry')}</DataTableHead>
                    <DataTableHead>{t('routing.colBackoff')}</DataTableHead>
                    <DataTableHead>{t('routing.colTimeouts')}</DataTableHead>
                    <DataTableHead>{t('routing.colBreaker')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>
                        <p className="font-medium">{row.name}</p>
                        {row.description === null ? null : (
                          <p className="mt-0.5 max-w-64 truncate text-xs text-muted-foreground">
                            {row.description}
                          </p>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        {row.fast_fail ? (
                          <Badge variant="warning">{t('routing.fastFailLabel')}</Badge>
                        ) : (
                          <span className="font-mono tabular-nums">
                            {t('routing.retryTimes', { times: row.retry_count })}
                          </span>
                        )}
                      </DataTableCell>
                      <DataTableCell className="whitespace-nowrap">
                        {row.backoff_type === 'exponential'
                          ? t('routing.backoffExponential')
                          : t('routing.backoffFixed')}
                        <span className="ml-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                          {String(row.backoff_ms)}ms
                        </span>
                      </DataTableCell>
                      <DataTableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                        {[
                          row.connect_timeout_ms,
                          row.ttft_timeout_ms,
                          row.total_timeout_ms,
                          row.idle_timeout_ms,
                        ]
                          .map(fmtMs)
                          .join(' / ')}
                      </DataTableCell>
                      <DataTableCell>
                        {row.breaker_enabled ? (
                          <Badge variant="success">{t('routing.breakerOn')}</Badge>
                        ) : (
                          <Badge variant="neutral">{t('routing.breakerOff')}</Badge>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
                          {row.status === 'active' ? t('common.active') : t('common.disabled')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.editPolicy')}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.deletePolicy')}
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

      <PolicyFormDialog
        open={createOpen || editing !== null}
        policy={editing}
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
        title={t('routing.deletePolicy')}
        description={deleting ? t('routing.deletePolicyConfirm', { name: deleting.name }) : ''}
        confirmLabel={t('common.delete')}
        pending={removeMutation.isPending}
        onConfirm={() => {
          if (deleting) removeMutation.mutate(deleting.id);
        }}
      />
    </PageTransition>
  );
}
