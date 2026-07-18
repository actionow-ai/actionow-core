import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Users, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { DetailList } from '@/components/common/detail-list';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
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

// Mirrors `subjectViewSchema` (packages/contracts/src/admin-views.ts).
interface SubjectRow {
  id: string;
  tenant_id: string;
  external_id: string | null;
  email: string | null;
  display_name: string | null;
  limit_plan_id: string | null;
  status: string;
  created_at: string;
}

// Mirrors `subAccountViewSchema` (packages/contracts/src/admin-views.ts).
interface SubAccountRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  credit_balance: string;
  credit_held: string;
  status: string;
  created_at: string;
}

// Mirrors `limitPlanViewSchema` (packages/contracts/src/limit.ts); only the fields we read.
interface PlanOption {
  id: string;
  name: string;
  status: string;
}

// Mirrors `limitRuleStatusViewSchema` (packages/contracts/src/limit.ts).
interface LimitRuleStatusRow {
  dimension: string;
  period: string | null;
  cap: string;
  used: string;
  model_scope: string | null;
  alert_pct: number | null;
  enforce: string;
}

const subjectStatusVariant: Record<string, 'success' | 'neutral' | 'danger'> = {
  active: 'success',
  disabled: 'neutral',
  deleted: 'danger',
};

const SUBJECTS_KEY = ['console', 'subjects'] as const;

/** Integer percentage of used/cap decimal strings; `null` when the cap is 0 or unparsable. */
function usagePct(used: string, cap: string): number | null {
  try {
    const capValue = BigInt(cap);
    if (capValue <= 0n) return null;
    return Number((BigInt(used) * 100n) / capValue);
  } catch {
    return null;
  }
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
    minute: t('tenantUsers.periodMinute'),
    day: t('tenantUsers.periodDay'),
    month: t('tenantUsers.periodMonth'),
    rolling_24h: t('tenantUsers.periodRolling24h'),
    rolling_30d: t('tenantUsers.periodRolling30d'),
    total: t('tenantUsers.periodTotal'),
  };
  return { dimensions, periods };
}

function SubjectStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const label =
    status === 'active'
      ? t('common.active')
      : status === 'disabled'
        ? t('common.disabled')
        : status === 'deleted'
          ? t('tenantUsers.statusDeleted')
          : status;
  return <Badge variant={subjectStatusVariant[status] ?? 'neutral'}>{label}</Badge>;
}

function MutationErrorText({ error }: { error: unknown }) {
  return <p className="text-sm text-danger">{toApiStateError(error).message}</p>;
}

function CreateSubjectDialog({ plans, onClose }: { plans: PlanOption[]; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [externalId, setExternalId] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [planId, setPlanId] = useState('none');

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<SubjectRow>('/console/subjects', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SUBJECTS_KEY });
      onClose();
    },
  });

  const canSubmit = externalId.trim() !== '' || email.trim() !== '';
  const submit = () => {
    const body: Record<string, unknown> = {};
    if (externalId.trim() !== '') body.externalId = externalId.trim();
    if (email.trim() !== '') body.email = email.trim();
    if (displayName.trim() !== '') body.displayName = displayName.trim();
    if (planId !== 'none') body.limitPlanId = planId;
    create.mutate(body);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantUsers.createSubjectTitle')}</DialogTitle>
          <DialogDescription>{t('tenantUsers.createSubjectDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField
            label={t('tenantUsers.externalIdLabel')}
            hint={t('tenantUsers.externalIdHint')}
          >
            {(id) => (
              <Input
                id={id}
                value={externalId}
                onChange={(event) => setExternalId(event.target.value)}
                className="font-mono"
              />
            )}
          </FormField>
          <FormField label={t('tenantUsers.emailLabel')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantUsers.displayNameLabel')} hint={t('common.optional')}>
            {(id) => (
              <Input
                id={id}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantUsers.planLabel')} hint={t('common.optional')}>
            {(id) => (
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('tenantUsers.planNone')}</SelectItem>
                  {plans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>
        {create.isError ? <MutationErrorText error={create.error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || create.isPending}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSubjectDialog({ subject, onClose }: { subject: SubjectRow; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(subject.email ?? '');
  const [displayName, setDisplayName] = useState(subject.display_name ?? '');
  const [status, setStatus] = useState(subject.status === 'disabled' ? 'disabled' : 'active');

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<SubjectRow>(`/console/subjects/${subject.id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SUBJECTS_KEY });
      onClose();
    },
  });

  const submit = () => {
    update.mutate({
      email: email.trim() === '' ? null : email.trim(),
      displayName: displayName.trim() === '' ? null : displayName.trim(),
      status,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantUsers.editSubjectTitle')}</DialogTitle>
          <DialogDescription>{t('tenantUsers.editSubjectDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantUsers.emailLabel')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantUsers.displayNameLabel')}>
            {(id) => (
              <Input
                id={id}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
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
        {update.isError ? <MutationErrorText error={update.error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={update.isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WalletMoveDialog({
  subjectId,
  mode,
  onClose,
}: {
  subjectId: string;
  mode: 'topup' | 'transfer';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [credits, setCredits] = useState('');
  const [direction, setDirection] = useState('to_subject');

  const move = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<SubAccountRow>(`/console/subjects/${subjectId}/sub-account/${mode}`, {
        method: 'POST',
        body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SUBJECTS_KEY });
      onClose();
    },
  });

  const amount = Number(credits);
  const canSubmit = credits.trim() !== '' && Number.isFinite(amount) && amount > 0;
  const submit = () => {
    move.mutate(mode === 'topup' ? { credits: amount } : { credits: amount, direction });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'topup' ? t('tenantUsers.topupTitle') : t('tenantUsers.transferTitle')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'topup'
              ? t('tenantUsers.topupDescription')
              : t('tenantUsers.transferDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantUsers.creditsLabel')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0"
                step="any"
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
                className="font-mono"
              />
            )}
          </FormField>
          {mode === 'transfer' ? (
            <FormField label={t('tenantUsers.directionLabel')}>
              {(id) => (
                <Select value={direction} onValueChange={setDirection}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="to_subject">{t('tenantUsers.toSubject')}</SelectItem>
                    <SelectItem value="to_tenant">{t('tenantUsers.toTenant')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          ) : null}
        </div>
        {move.isError ? <MutationErrorText error={move.error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={move.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || move.isPending}>
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubjectWalletSection({ subject }: { subject: SubjectRow }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [walletDialog, setWalletDialog] = useState<'topup' | 'transfer' | null>(null);

  const subAccount = useQuery({
    queryKey: [...SUBJECTS_KEY, subject.id, 'sub-account'],
    queryFn: () => apiFetch<SubAccountRow>(`/console/subjects/${subject.id}/sub-account`),
  });
  const sharedPool = subAccount.error instanceof ApiError && subAccount.error.status === 404;

  const openWallet = useMutation({
    mutationFn: () =>
      apiFetch<SubAccountRow>(`/console/subjects/${subject.id}/sub-account/open`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...SUBJECTS_KEY, subject.id] });
    },
  });

  return (
    <section>
      <h3 className="text-sm font-semibold">{t('tenantUsers.walletTitle')}</h3>
      <div className="mt-2">
        {subAccount.isLoading ? (
          <ResourceLoading rows={1} />
        ) : sharedPool ? (
          <div className="rounded-xl bg-surface-subtle">
            <EmptyState
              icon={Wallet}
              title={t('tenantUsers.walletSharedTitle')}
              description={t('tenantUsers.walletSharedDescription')}
              action={
                <div className="grid justify-items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => openWallet.mutate()}
                    disabled={openWallet.isPending}
                  >
                    <Wallet />
                    {t('tenantUsers.openWallet')}
                  </Button>
                  {openWallet.isError ? <MutationErrorText error={openWallet.error} /> : null}
                </div>
              }
            />
          </div>
        ) : subAccount.isError ? (
          <ApiErrorNotice
            error={toApiStateError(subAccount.error)}
            onRetry={() => void subAccount.refetch()}
          />
        ) : subAccount.data ? (
          <>
            <DetailList
              items={[
                {
                  label: t('tenantUsers.balance'),
                  value: <MoneyText value={subAccount.data.credit_balance} />,
                },
                {
                  label: t('tenantUsers.held'),
                  value: <MoneyText value={subAccount.data.credit_held} />,
                },
                {
                  label: t('common.status'),
                  value: (
                    <Badge variant={subAccount.data.status === 'active' ? 'success' : 'neutral'}>
                      {subAccount.data.status === 'active'
                        ? t('common.active')
                        : t('common.disabled')}
                    </Badge>
                  ),
                },
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setWalletDialog('topup')}>
                <Plus />
                {t('tenantUsers.topup')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setWalletDialog('transfer')}>
                {t('tenantUsers.transfer')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      {walletDialog !== null ? (
        <WalletMoveDialog
          subjectId={subject.id}
          mode={walletDialog}
          onClose={() => setWalletDialog(null)}
        />
      ) : null}
    </section>
  );
}

function SubjectLimitSection({ subject, plans }: { subject: SubjectRow; plans: PlanOption[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { dimensions, periods } = useLimitLabels();

  const limitStatus = useQuery({
    queryKey: [...SUBJECTS_KEY, subject.id, 'limit-status'],
    queryFn: () => apiFetch<LimitRuleStatusRow[]>(`/console/subjects/${subject.id}/limit-status`),
  });

  const bindPlan = useMutation({
    mutationFn: (planId: string | null) =>
      apiFetch<{ ok: true }>(`/console/subjects/${subject.id}/limit-plan`, {
        method: 'POST',
        body: { planId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
  });

  return (
    <section>
      <h3 className="text-sm font-semibold">{t('tenantUsers.limitTitle')}</h3>
      <div className="mt-2 grid gap-3">
        <FormField label={t('tenantUsers.boundPlanLabel')}>
          {(id) => (
            <Select
              value={subject.limit_plan_id ?? 'none'}
              onValueChange={(value) => bindPlan.mutate(value === 'none' ? null : value)}
              disabled={bindPlan.isPending}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('tenantUsers.planNone')}</SelectItem>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        {bindPlan.isError ? <MutationErrorText error={bindPlan.error} /> : null}
        {limitStatus.isLoading ? (
          <ResourceLoading rows={2} />
        ) : limitStatus.isError ? (
          <ApiErrorNotice
            error={toApiStateError(limitStatus.error)}
            onRetry={() => void limitStatus.refetch()}
          />
        ) : !limitStatus.data || limitStatus.data.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t('tenantUsers.limitRulesEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {limitStatus.data.map((rule, index) => {
              const pct = usagePct(rule.used, rule.cap);
              const exceeded = pct !== null && pct >= 100;
              return (
                <li key={index} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm">
                      {dimensions[rule.dimension] ?? rule.dimension}
                      {rule.period !== null ? ` · ${periods[rule.period] ?? rule.period}` : ''}
                    </p>
                    {rule.model_scope !== null ? (
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {rule.model_scope}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={`font-mono text-sm tabular-nums ${exceeded ? 'text-danger' : ''}`}
                    >
                      {rule.dimension === 'spend' ? (
                        <>
                          <MoneyText value={rule.used} className={exceeded ? 'text-danger' : ''} />
                          {' / '}
                          <MoneyText value={rule.cap} className={exceeded ? 'text-danger' : ''} />
                        </>
                      ) : (
                        `${rule.used} / ${rule.cap}`
                      )}
                    </p>
                    {pct !== null ? (
                      <p
                        className={`mt-0.5 font-mono text-xs tabular-nums ${
                          exceeded ? 'text-danger' : 'text-muted-foreground'
                        }`}
                      >
                        {String(pct)}%
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function SubjectSheet({
  subject,
  plans,
  onClose,
}: {
  subject: SubjectRow;
  plans: PlanOption[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const planName = plans.find((plan) => plan.id === subject.limit_plan_id)?.name;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-[460px] max-w-[92vw] gap-0 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('tenantUsers.subjectSheetTitle')}</SheetTitle>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-8">
          <DetailList
            items={[
              {
                label: t('common.id'),
                value: <span className="font-mono text-xs">{subject.id}</span>,
              },
              {
                label: t('tenantUsers.colExternalId'),
                value:
                  subject.external_id !== null ? (
                    <span className="font-mono">{subject.external_id}</span>
                  ) : (
                    '—'
                  ),
              },
              { label: t('tenantUsers.colEmail'), value: subject.email ?? '—' },
              { label: t('tenantUsers.colDisplayName'), value: subject.display_name ?? '—' },
              { label: t('common.status'), value: <SubjectStatusBadge status={subject.status} /> },
              { label: t('tenantUsers.colPlan'), value: planName ?? t('tenantUsers.planNone') },
              { label: t('common.createdAt'), value: <DateTimeText value={subject.created_at} /> },
            ]}
          />
          <SubjectWalletSection subject={subject} />
          <SubjectLimitSection subject={subject} plans={plans} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function SubjectsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SubjectRow | null>(null);
  const [deleting, setDeleting] = useState<SubjectRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const subjects = useCursorQuery<SubjectRow>({ key: SUBJECTS_KEY, path: '/console/subjects' });
  const plansQuery = useQuery({
    queryKey: ['console', 'limit-plans'],
    queryFn: () => apiFetch<PlanOption[]>('/console/limit-plans'),
  });
  const plans = plansQuery.data ?? [];
  const planNames = new Map(plans.map((plan) => [plan.id, plan.name]));

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; status: string }>(`/console/subjects/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onSettled: () => {
      setDeleting(null);
      setSelectedId(null);
    },
  });

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      term === ''
        ? subjects.rows
        : subjects.rows.filter((row) =>
            [row.external_id, row.email, row.display_name].some(
              (value) => value?.toLowerCase().includes(term) ?? false,
            ),
          ),
    [subjects.rows, term],
  );
  const selected =
    selectedId === null ? null : (subjects.rows.find((row) => row.id === selectedId) ?? null);

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantUsers.subjectsTitle')}
        description={t('tenantUsers.subjectsDescription')}
      />

      {remove.isError ? (
        <ApiErrorNotice error={toApiStateError(remove.error)} className="mb-4" />
      ) : null}

      <Card>
        <DataTableToolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('tenantUsers.searchSubjects'),
          }}
          onRefresh={() => void subjects.refetch()}
          refreshing={subjects.isRefetching}
        >
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('tenantUsers.newSubject')}
          </Button>
        </DataTableToolbar>
        {subjects.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : subjects.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(subjects.error)}
              onRetry={() => void subjects.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t('tenantUsers.subjectsEmptyTitle')}
            description={t('tenantUsers.subjectsEmptyDescription')}
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                {t('tenantUsers.newSubject')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('tenantUsers.colExternalId')}</DataTableHead>
                    <DataTableHead>{t('tenantUsers.colEmail')}</DataTableHead>
                    <DataTableHead>{t('tenantUsers.colDisplayName')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('tenantUsers.colPlan')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(row.id)}
                    >
                      <DataTableCell className="font-mono text-sm">
                        {row.external_id ?? '—'}
                      </DataTableCell>
                      <DataTableCell>{row.email ?? '—'}</DataTableCell>
                      <DataTableCell>{row.display_name ?? '—'}</DataTableCell>
                      <DataTableCell>
                        <SubjectStatusBadge status={row.status} />
                      </DataTableCell>
                      <DataTableCell>
                        {row.limit_plan_id !== null
                          ? (planNames.get(row.limit_plan_id) ?? (
                              <span className="font-mono text-xs">
                                {row.limit_plan_id.slice(0, 8)}
                              </span>
                            ))
                          : t('tenantUsers.planNone')}
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
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditing(row);
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
                count={subjects.rows.length}
                hasMore={subjects.hasNextPage}
                loading={subjects.isFetchingNextPage}
                onLoadMore={() => void subjects.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      {createOpen ? (
        <CreateSubjectDialog plans={plans} onClose={() => setCreateOpen(false)} />
      ) : null}
      {editing !== null ? (
        <EditSubjectDialog subject={editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('tenantUsers.deleteSubjectTitle')}
        description={t('tenantUsers.deleteSubjectDescription')}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting.id);
        }}
      />
      {selected !== null ? (
        <SubjectSheet subject={selected} plans={plans} onClose={() => setSelectedId(null)} />
      ) : null}
    </PageTransition>
  );
}
