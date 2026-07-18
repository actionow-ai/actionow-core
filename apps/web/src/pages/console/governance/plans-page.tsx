import type { LimitDimension, LimitPlanView, LimitRuleInput } from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilLine, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
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
  DataTablePagination,
  DataTableRow,
  DataTableSortHead,
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
import { useDataTable } from '@/hooks/use-data-table';

const DIMENSIONS: LimitDimension[] = ['spend', 'requests', 'tokens', 'rpm', 'concurrency'];
const ACCUM_PERIODS = ['day', 'month', 'rolling_24h', 'rolling_30d', 'total'] as const;

const planStatusVariant: Record<string, 'success' | 'neutral'> = {
  active: 'success',
  disabled: 'neutral',
};

interface RuleDraft {
  key: number;
  dimension: LimitDimension;
  period: string;
  cap: string;
  modelScope: string;
  alertPct: string;
}

type EditorState = { mode: 'create' } | { mode: 'edit'; plan: LimitPlanView };

function isCapValid(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function isAlertPctValid(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (!/^\d+$/.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= 100;
}

function isRuleValid(rule: RuleDraft): boolean {
  if (!isCapValid(rule.cap) || !isAlertPctValid(rule.alertPct)) return false;
  if (rule.dimension === 'rpm' || rule.dimension === 'concurrency') return true;
  return (ACCUM_PERIODS as readonly string[]).includes(rule.period);
}

function toRuleInput(rule: RuleDraft): LimitRuleInput {
  return {
    dimension: rule.dimension,
    period:
      rule.dimension === 'concurrency'
        ? null
        : rule.dimension === 'rpm'
          ? 'minute'
          : (rule.period as LimitRuleInput['period']),
    cap: Number(rule.cap.trim()),
    modelScope: rule.modelScope.trim() === '' ? null : rule.modelScope.trim(),
    alertPct: rule.alertPct.trim() === '' ? null : Number(rule.alertPct.trim()),
  };
}

export function LimitPlansPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const plans = useQuery({
    queryKey: ['admin', 'limit-plans'],
    queryFn: () => apiFetch<LimitPlanView[]>('/admin/limit-plans'),
  });

  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LimitPlanView | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const ruleKeyCounter = useRef(0);

  const nextRuleKey = () => {
    ruleKeyCounter.current += 1;
    return ruleKeyCounter.current;
  };

  const filtered = useMemo(() => {
    const rows = plans.data ?? [];
    const query = search.trim().toLowerCase();
    if (query === '') return rows;
    return rows.filter((plan) =>
      [plan.name, plan.description ?? '', plan.id].some((field) =>
        field.toLowerCase().includes(query),
      ),
    );
  }, [plans.data, search]);

  const table = useDataTable(filtered, {
    pageSize: 20,
    sortValues: {
      name: (row) => row.name,
      rules: (row) => row.rules.length,
      keys: (row) => row.key_count,
      tenants: (row) => row.tenant_count,
      created: (row) => row.created_at,
    },
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        status,
        rules: rules.map(toRuleInput),
      };
      return editor?.mode === 'edit'
        ? apiFetch<LimitPlanView>(`/admin/limit-plans/${editor.plan.id}`, {
            method: 'PATCH',
            body,
          })
        : apiFetch<LimitPlanView>('/admin/limit-plans', { method: 'POST', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'limit-plans'] });
      setEditor(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch<unknown>(`/admin/limit-plans/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'limit-plans'] });
      setDeleteTarget(null);
    },
  });

  const openCreate = () => {
    setName('');
    setDescription('');
    setStatus('active');
    setRules([]);
    save.reset();
    setEditor({ mode: 'create' });
  };

  const openEdit = (plan: LimitPlanView) => {
    setName(plan.name);
    setDescription(plan.description ?? '');
    setStatus(plan.status === 'disabled' ? 'disabled' : 'active');
    setRules(
      plan.rules.map((rule) => ({
        key: nextRuleKey(),
        dimension: rule.dimension,
        period: rule.period ?? '',
        cap: rule.cap,
        modelScope: rule.model_scope ?? '',
        alertPct: rule.alert_pct === null ? '' : String(rule.alert_pct),
      })),
    );
    save.reset();
    setEditor({ mode: 'edit', plan });
  };

  const updateRule = (key: number, patch: Partial<RuleDraft>) => {
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  };

  const changeDimension = (key: number, dimension: LimitDimension) => {
    setRules((current) =>
      current.map((rule) => {
        if (rule.key !== key) return rule;
        const period =
          dimension === 'rpm'
            ? 'minute'
            : dimension === 'concurrency'
              ? ''
              : (ACCUM_PERIODS as readonly string[]).includes(rule.period)
                ? rule.period
                : 'day';
        return { ...rule, dimension, period };
      }),
    );
  };

  const addRule = () => {
    setRules((current) => [
      ...current,
      {
        key: nextRuleKey(),
        dimension: 'spend',
        period: 'day',
        cap: '',
        modelScope: '',
        alertPct: '',
      },
    ]);
  };

  const removeRule = (key: number) => {
    setRules((current) => current.filter((rule) => rule.key !== key));
  };

  const formValid = name.trim() !== '' && rules.every(isRuleValid);

  const dimensionLabel = (dimension: string) => t(`governance.dimension_${dimension}`);
  const periodLabel = (period: string | null) =>
    period === null || period === '' ? t('governance.noPeriod') : t(`governance.period_${period}`);

  return (
    <PageTransition>
      <PageHeader
        title={t('governance.plansTitle')}
        description={t('governance.plansDescription')}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            {t('governance.createPlan')}
          </Button>
        }
      />

      {plans.isLoading ? (
        <ResourceLoading rows={5} />
      ) : plans.isError ? (
        <ApiErrorNotice error={toApiStateError(plans.error)} onRetry={() => void plans.refetch()} />
      ) : (
        <Card className="overflow-hidden">
          <DataTableToolbar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: t('governance.searchPlans'),
            }}
            onRefresh={() => void plans.refetch()}
            refreshing={plans.isFetching}
          />
          {filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('governance.plansEmpty')}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <DataTable className="min-w-[920px]">
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableSortHead
                        direction={table.directionFor('name')}
                        onToggle={() => table.toggleSort('name')}
                      >
                        {t('common.name')}
                      </DataTableSortHead>
                      <DataTableHead>{t('common.status')}</DataTableHead>
                      <DataTableHead>{t('governance.colScope')}</DataTableHead>
                      <DataTableSortHead
                        direction={table.directionFor('rules')}
                        onToggle={() => table.toggleSort('rules')}
                      >
                        {t('governance.colRules')}
                      </DataTableSortHead>
                      <DataTableSortHead
                        direction={table.directionFor('keys')}
                        onToggle={() => table.toggleSort('keys')}
                      >
                        {t('governance.colKeys')}
                      </DataTableSortHead>
                      <DataTableSortHead
                        direction={table.directionFor('tenants')}
                        onToggle={() => table.toggleSort('tenants')}
                      >
                        {t('governance.colTenants')}
                      </DataTableSortHead>
                      <DataTableSortHead
                        direction={table.directionFor('created')}
                        onToggle={() => table.toggleSort('created')}
                      >
                        {t('common.createdAt')}
                      </DataTableSortHead>
                      <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {table.rows.map((plan) => (
                      <DataTableRow key={plan.id}>
                        <DataTableCell>
                          <p className="font-medium">{plan.name}</p>
                          {plan.description ? (
                            <p className="mt-0.5 max-w-64 truncate text-xs text-muted-foreground">
                              {plan.description}
                            </p>
                          ) : null}
                        </DataTableCell>
                        <DataTableCell>
                          <Badge variant={planStatusVariant[plan.status] ?? 'neutral'}>
                            {plan.status === 'active'
                              ? t('governance.statusActive')
                              : plan.status === 'disabled'
                                ? t('governance.statusDisabled')
                                : plan.status}
                          </Badge>
                        </DataTableCell>
                        <DataTableCell>
                          {plan.tenant_id === null ? (
                            <Badge variant="neutral">{t('governance.scopePlatform')}</Badge>
                          ) : (
                            <span className="font-mono text-xs">{plan.tenant_id.slice(0, 8)}</span>
                          )}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {plan.rules.length}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {plan.key_count}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {plan.tenant_count}
                        </DataTableCell>
                        <DataTableCell>
                          <DateTimeText value={plan.created_at} className="text-xs" />
                        </DataTableCell>
                        <DataTableCell className="text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('governance.editPlan')}
                            onClick={() => openEdit(plan)}
                          >
                            <PencilLine className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('governance.deletePlan')}
                            onClick={() => {
                              remove.reset();
                              setDeleteTarget(plan);
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
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
      )}

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === 'edit' ? t('governance.editPlan') : t('governance.createPlan')}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <FormField label={t('governance.planName')}>
              {(id) => (
                <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
              )}
            </FormField>
            <FormField label={t('governance.planDescription')} hint={t('common.optional')}>
              {(id) => (
                <Textarea
                  id={id}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="min-h-16"
                />
              )}
            </FormField>
            <FormField label={t('common.status')}>
              {(id) => (
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(value === 'disabled' ? 'disabled' : 'active')}
                >
                  <SelectTrigger id={id} aria-label={t('common.status')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t('governance.statusActive')}</SelectItem>
                    <SelectItem value="disabled">{t('governance.statusDisabled')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{t('governance.rulesTitle')}</p>
              <Button variant="outline" size="sm" onClick={addRule}>
                <Plus className="size-4" />
                {t('governance.addRule')}
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('governance.noRules')}</p>
            ) : (
              rules.map((rule, index) => (
                <div key={rule.key} className="rounded-xl bg-surface-subtle/60 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('governance.ruleIndex', { index: index + 1 })}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('governance.removeRule')}
                      onClick={() => removeRule(rule.key)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('governance.dimension')}>
                      {(id) => (
                        <Select
                          value={rule.dimension}
                          onValueChange={(value) =>
                            changeDimension(rule.key, value as LimitDimension)
                          }
                        >
                          <SelectTrigger id={id} aria-label={t('governance.dimension')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DIMENSIONS.map((dimension) => (
                              <SelectItem key={dimension} value={dimension}>
                                {dimensionLabel(dimension)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </FormField>
                    <FormField label={t('governance.period')}>
                      {(id) =>
                        rule.dimension === 'rpm' || rule.dimension === 'concurrency' ? (
                          <Input
                            id={id}
                            value={
                              rule.dimension === 'rpm'
                                ? periodLabel('minute')
                                : t('governance.noPeriod')
                            }
                            readOnly
                            disabled
                          />
                        ) : (
                          <Select
                            value={rule.period}
                            onValueChange={(value) => updateRule(rule.key, { period: value })}
                          >
                            <SelectTrigger id={id} aria-label={t('governance.period')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ACCUM_PERIODS.map((period) => (
                                <SelectItem key={period} value={period}>
                                  {periodLabel(period)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )
                      }
                    </FormField>
                    <FormField
                      label={t('governance.cap')}
                      hint={rule.dimension === 'spend' ? t('governance.capHintSpend') : undefined}
                      error={
                        rule.cap.trim() !== '' && !isCapValid(rule.cap)
                          ? t('governance.capInvalid')
                          : undefined
                      }
                    >
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={0}
                          step={1}
                          value={rule.cap}
                          onChange={(event) => updateRule(rule.key, { cap: event.target.value })}
                          className="font-mono"
                        />
                      )}
                    </FormField>
                    <FormField
                      label={t('governance.modelScope')}
                      hint={t('governance.modelScopeHint')}
                    >
                      {(id) => (
                        <Input
                          id={id}
                          value={rule.modelScope}
                          onChange={(event) =>
                            updateRule(rule.key, { modelScope: event.target.value })
                          }
                          className="font-mono"
                        />
                      )}
                    </FormField>
                    <FormField
                      label={t('governance.alertPct')}
                      hint={t('governance.alertPctHint')}
                      error={
                        isAlertPctValid(rule.alertPct) ? undefined : t('governance.alertPctInvalid')
                      }
                    >
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          value={rule.alertPct}
                          onChange={(event) =>
                            updateRule(rule.key, { alertPct: event.target.value })
                          }
                          className="font-mono"
                        />
                      )}
                    </FormField>
                  </div>
                </div>
              ))
            )}

            {save.isError ? <ApiErrorNotice error={toApiStateError(save.error)} /> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)} disabled={save.isPending}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => save.mutate()} disabled={!formValid || save.isPending}>
              {save.isPending ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('governance.deletePlan')}
        description={
          deleteTarget ? t('governance.deletePlanConfirm', { name: deleteTarget.name }) : undefined
        }
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
      />
    </PageTransition>
  );
}
