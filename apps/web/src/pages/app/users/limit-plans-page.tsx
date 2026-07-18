import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
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

// Mirrors `limitRuleViewSchema` (packages/contracts/src/limit.ts).
interface PlanRuleRow {
  id: string;
  dimension: string;
  period: string | null;
  cap: string;
  model_scope: string | null;
  alert_pct: number | null;
  enforce: string;
}

// Mirrors `limitPlanViewSchema` (packages/contracts/src/limit.ts).
interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  tenant_id: string | null;
  rules: PlanRuleRow[];
  key_count: number;
  tenant_count: number;
  created_at: string;
  updated_at: string;
}

interface RuleDraft {
  key: number;
  dimension: string;
  period: string;
  cap: string;
  modelScope: string;
  alertPct: string;
}

const DIMENSIONS = ['spend', 'requests', 'tokens', 'rpm', 'concurrency'] as const;
const ACCUM_PERIODS = ['day', 'month', 'rolling_24h', 'rolling_30d', 'total'] as const;

const PLANS_KEY = ['console', 'limit-plans'] as const;

function ruleValid(draft: RuleDraft): boolean {
  const cap = Number(draft.cap);
  if (draft.cap.trim() === '' || !Number.isInteger(cap) || cap < 0) return false;
  if (draft.alertPct.trim() !== '') {
    const pct = Number(draft.alertPct);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return false;
  }
  return true;
}

function useLimitLabels() {
  const { t } = useTranslation();
  const dimensions: Record<string, string> = {
    spend: t('tenantUsers.dimSpend'),
    requests: t('tenantUsers.dimRequests'),
    tokens: t('tenantUsers.dimTokens'),
    rpm: t('tenantUsers.dimRpm'),
    concurrency: t('tenantUsers.dimConcurrency'),
  };
  const periods: Record<string, string> = {
    day: t('tenantUsers.periodDay'),
    month: t('tenantUsers.periodMonth'),
    rolling_24h: t('tenantUsers.periodRolling24h'),
    rolling_30d: t('tenantUsers.periodRolling30d'),
    total: t('tenantUsers.periodTotal'),
  };
  return { dimensions, periods };
}

function PlanDialog({ plan, onClose }: { plan: PlanRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { dimensions, periods } = useLimitLabels();
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [status, setStatus] = useState(plan?.status === 'disabled' ? 'disabled' : 'active');
  const [drafts, setDrafts] = useState<RuleDraft[]>(() =>
    plan
      ? plan.rules.map((rule, index) => ({
          key: index,
          dimension: rule.dimension,
          period: rule.period ?? '',
          cap: rule.cap,
          modelScope: rule.model_scope ?? '',
          alertPct: rule.alert_pct === null ? '' : String(rule.alert_pct),
        }))
      : [],
  );
  const nextKey = useRef(plan ? plan.rules.length : 0);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      plan
        ? apiFetch<PlanRow>(`/console/limit-plans/${plan.id}`, { method: 'PATCH', body })
        : apiFetch<PlanRow>('/console/limit-plans', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLANS_KEY });
      onClose();
    },
  });

  const addRule = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    setDrafts((prev) => [
      ...prev,
      { key, dimension: 'requests', period: 'day', cap: '', modelScope: '', alertPct: '' },
    ]);
  };
  const removeRule = (key: number) => {
    setDrafts((prev) => prev.filter((draft) => draft.key !== key));
  };
  const patchRule = (key: number, patch: Partial<RuleDraft>) => {
    setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };
  const setDimension = (key: number, dimension: string) => {
    setDrafts((prev) =>
      prev.map((draft) => {
        if (draft.key !== key) return draft;
        const period =
          dimension === 'rpm'
            ? 'minute'
            : dimension === 'concurrency'
              ? ''
              : (ACCUM_PERIODS as readonly string[]).includes(draft.period)
                ? draft.period
                : 'day';
        return { ...draft, dimension, period };
      }),
    );
  };

  const canSubmit = name.trim() !== '' && drafts.every(ruleValid);
  const submit = () => {
    save.mutate({
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      status,
      rules: drafts.map((draft) => ({
        dimension: draft.dimension,
        period:
          draft.dimension === 'concurrency'
            ? null
            : draft.dimension === 'rpm'
              ? 'minute'
              : draft.period,
        cap: Number(draft.cap),
        modelScope: draft.modelScope.trim() === '' ? null : draft.modelScope.trim(),
        alertPct: draft.alertPct.trim() === '' ? null : Number(draft.alertPct),
      })),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {plan ? t('tenantUsers.editPlanTitle') : t('tenantUsers.createPlanTitle')}
          </DialogTitle>
          <DialogDescription>{t('tenantUsers.planDialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('common.name')}>
              {(id) => (
                <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
              )}
            </FormField>
            <FormField label={t('common.status')}>
              {(id) => (
                <Select value={status} onValueChange={setStatus}>
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
          </div>
          <FormField label={t('common.description')} hint={t('common.optional')}>
            {(id) => (
              <Input
                id={id}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </FormField>

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('tenantUsers.rulesTitle')}</h3>
            <Button variant="outline" size="sm" onClick={addRule}>
              <Plus />
              {t('tenantUsers.addRule')}
            </Button>
          </div>
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('tenantUsers.rulesEmpty')}</p>
          ) : (
            <div className="grid gap-3">
              {drafts.map((draft, index) => (
                <div key={draft.key} className="rounded-xl bg-surface-subtle p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('tenantUsers.ruleLabel', { index: index + 1 })}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('tenantUsers.removeRule')}
                      onClick={() => removeRule(draft.key)}
                    >
                      <X />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FormField label={t('tenantUsers.dimensionLabel')}>
                      {(id) => (
                        <Select
                          value={draft.dimension}
                          onValueChange={(value) => setDimension(draft.key, value)}
                        >
                          <SelectTrigger id={id} className="bg-surface">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DIMENSIONS.map((dimension) => (
                              <SelectItem key={dimension} value={dimension}>
                                {dimensions[dimension]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </FormField>
                    <FormField label={t('tenantUsers.periodLabel')}>
                      {(id) => (
                        <Select
                          value={draft.dimension === 'concurrency' ? 'none' : draft.period}
                          onValueChange={(value) => patchRule(draft.key, { period: value })}
                          disabled={draft.dimension === 'rpm' || draft.dimension === 'concurrency'}
                        >
                          <SelectTrigger id={id} className="bg-surface">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {draft.dimension === 'rpm' ? (
                              <SelectItem value="minute">
                                {t('tenantUsers.periodMinute')}
                              </SelectItem>
                            ) : draft.dimension === 'concurrency' ? (
                              <SelectItem value="none">{t('tenantUsers.periodNone')}</SelectItem>
                            ) : (
                              ACCUM_PERIODS.map((period) => (
                                <SelectItem key={period} value={period}>
                                  {periods[period]}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      )}
                    </FormField>
                    <FormField label={t('tenantUsers.capLabel')} hint={t('tenantUsers.capHint')}>
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min="0"
                          step="1"
                          value={draft.cap}
                          onChange={(event) => patchRule(draft.key, { cap: event.target.value })}
                          className="bg-surface font-mono"
                        />
                      )}
                    </FormField>
                    <FormField
                      label={t('tenantUsers.modelScopeLabel')}
                      hint={t('common.optional')}
                      className="sm:col-span-2"
                    >
                      {(id) => (
                        <Input
                          id={id}
                          value={draft.modelScope}
                          onChange={(event) =>
                            patchRule(draft.key, { modelScope: event.target.value })
                          }
                          placeholder={t('tenantUsers.modelScopePlaceholder')}
                          className="bg-surface font-mono"
                        />
                      )}
                    </FormField>
                    <FormField label={t('tenantUsers.alertPctLabel')} hint={t('common.optional')}>
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min="1"
                          max="100"
                          step="1"
                          value={draft.alertPct}
                          onChange={(event) =>
                            patchRule(draft.key, { alertPct: event.target.value })
                          }
                          className="bg-surface font-mono"
                        />
                      )}
                    </FormField>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {save.isError ? (
          <p className="text-sm text-danger">{toApiStateError(save.error).message}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || save.isPending}>
            {plan ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppLimitPlansPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ plan: PlanRow | null } | null>(null);
  const [deleting, setDeleting] = useState<PlanRow | null>(null);

  const plansQuery = useQuery({
    queryKey: PLANS_KEY,
    queryFn: () => apiFetch<PlanRow[]>('/console/limit-plans'),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<undefined>(`/console/limit-plans/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLANS_KEY });
    },
    onSettled: () => setDeleting(null),
  });

  const term = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = plansQuery.data ?? [];
    return term === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(term));
  }, [plansQuery.data, term]);

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantUsers.plansTitle')}
        description={t('tenantUsers.plansDescription')}
      />

      {remove.isError ? (
        <ApiErrorNotice error={toApiStateError(remove.error)} className="mb-4" />
      ) : null}

      <Card>
        <DataTableToolbar
          search={{ value: search, onChange: setSearch, placeholder: t('tenantUsers.searchPlans') }}
          onRefresh={() => void plansQuery.refetch()}
          refreshing={plansQuery.isRefetching}
        >
          <Button onClick={() => setDialog({ plan: null })}>
            <Plus />
            {t('tenantUsers.newPlan')}
          </Button>
        </DataTableToolbar>
        {plansQuery.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={3} />
          </div>
        ) : plansQuery.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(plansQuery.error)}
              onRetry={() => void plansQuery.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title={t('tenantUsers.plansEmptyTitle')}
            description={t('tenantUsers.plansEmptyDescription')}
            action={
              <Button onClick={() => setDialog({ plan: null })}>
                <Plus />
                {t('tenantUsers.newPlan')}
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <DataTable>
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead>{t('common.name')}</DataTableHead>
                  <DataTableHead>{t('common.status')}</DataTableHead>
                  <DataTableHead>{t('tenantUsers.colRules')}</DataTableHead>
                  <DataTableHead>{t('common.createdAt')}</DataTableHead>
                  <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {filtered.map((row) => (
                  <DataTableRow key={row.id}>
                    <DataTableCell>
                      <p className="font-medium">{row.name}</p>
                      {row.description !== null ? (
                        <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                          {row.description}
                        </p>
                      ) : null}
                    </DataTableCell>
                    <DataTableCell>
                      <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
                        {row.status === 'active' ? t('common.active') : t('common.disabled')}
                      </Badge>
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {row.rules.length}
                    </DataTableCell>
                    <DataTableCell>
                      <DateTimeText value={row.created_at} className="text-sm" />
                    </DataTableCell>
                    <DataTableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common.edit')}
                          onClick={() => setDialog({ plan: row })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common.delete')}
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
        )}
      </Card>

      {dialog !== null ? <PlanDialog plan={dialog.plan} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('tenantUsers.deletePlanTitle')}
        description={t('tenantUsers.deletePlanDescription')}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting.id);
        }}
      />
    </PageTransition>
  );
}
