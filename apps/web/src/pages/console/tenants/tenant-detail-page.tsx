import type {
  AccountView,
  CreateSubjectBody,
  LimitPlanView,
  SubAccountView,
  SubjectView,
  TenantView,
  TransferCreditsBody,
  UpdateSubjectBody,
} from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Trash2, Users, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { ApiError, apiFetch, type PageOf, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/copy-button';
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

const ISOLATION_KEYS: Record<string, string> = {
  field: 'tenantsAdmin.isolationField',
  schema: 'tenantsAdmin.isolationSchema',
  db: 'tenantsAdmin.isolationDb',
};

type IsolationMode = 'field' | 'schema' | 'db';

const subjectStatusVariant: Record<string, 'success' | 'neutral'> = {
  active: 'success',
  disabled: 'neutral',
};

function MutationErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-danger">{toApiStateError(error).message}</p>;
}

function positiveNumber(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function PlanSelectItems({ plans }: { plans: LimitPlanView[] }) {
  const { t } = useTranslation();
  return (
    <SelectContent>
      <SelectItem value="none">{t('tenantsAdmin.planNone')}</SelectItem>
      {plans.map((plan) => (
        <SelectItem key={plan.id} value={plan.id}>
          {plan.name}
          {plan.status !== 'active' ? ` (${t('common.disabled')})` : ''}
        </SelectItem>
      ))}
    </SelectContent>
  );
}

// ----- tenant info -----

function EditTenantDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isolation, setIsolation] = useState<IsolationMode>(
    tenant.isolation_mode === 'schema' || tenant.isolation_mode === 'db'
      ? tenant.isolation_mode
      : 'field',
  );

  const update = useMutation({
    mutationFn: (isolationMode: IsolationMode) =>
      apiFetch<TenantView>(`/admin/tenants/${tenant.id}`, {
        method: 'PATCH',
        body: { isolationMode },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenant.id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.editTenantTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.editTenantDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantsAdmin.colIsolation')} hint={t('tenantsAdmin.isolationHint')}>
            {(id) => (
              <Select
                value={isolation}
                onValueChange={(next) => setIsolation(next as IsolationMode)}
              >
                <SelectTrigger id={id} aria-label={t('tenantsAdmin.colIsolation')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['field', 'schema', 'db'] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(ISOLATION_KEYS[mode] ?? 'common.none')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <MutationErrorText error={update.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => update.mutate(isolation)} disabled={update.isPending}>
            {update.isPending ? t('common.loading') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----- wallet -----

function TopupDialog({
  accountId,
  tenantId,
  open,
  onOpenChange,
}: {
  accountId: string;
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>(undefined);

  const topup = useMutation({
    mutationFn: (credits: number) =>
      apiFetch<{ account_id: string; balance: string }>(`/admin/accounts/${accountId}/topup`, {
        method: 'POST',
        body: { credits },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-account', tenantId] });
      onOpenChange(false);
      setAmount('');
    },
  });

  const submit = () => {
    const credits = positiveNumber(amount);
    if (credits === null) {
      setAmountError(t('tenantsAdmin.numberInvalid'));
      return;
    }
    setAmountError(undefined);
    topup.mutate(credits);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.topupTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.topupDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantsAdmin.topupAmount')} error={amountError}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            )}
          </FormField>
          <MutationErrorText error={topup.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={topup.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={topup.isPending}>
            {topup.isPending ? t('common.loading') : t('tenantsAdmin.topup')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BindPlanDialog({
  tenantId,
  currentPlanId,
  plans,
  open,
  onOpenChange,
}: {
  tenantId: string;
  currentPlanId: string | null;
  plans: LimitPlanView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(currentPlanId ?? 'none');

  const bind = useMutation({
    mutationFn: (planId: string | null) =>
      apiFetch<{ ok: true }>(`/admin/tenants/${tenantId}/limit-plan`, {
        method: 'POST',
        body: { planId },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-account', tenantId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'limit-plans'] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.bindPlanTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.bindPlanDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantsAdmin.limitPlan')}>
            {(id) => (
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger id={id} aria-label={t('tenantsAdmin.limitPlan')}>
                  <SelectValue />
                </SelectTrigger>
                <PlanSelectItems plans={plans} />
              </Select>
            )}
          </FormField>
          <MutationErrorText error={bind.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={bind.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => bind.mutate(selected === 'none' ? null : selected)}
            disabled={bind.isPending}
          >
            {bind.isPending ? t('common.loading') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----- subjects -----

function CreateSubjectDialog({
  tenantId,
  plans,
  open,
  onOpenChange,
}: {
  tenantId: string;
  plans: LimitPlanView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [externalId, setExternalId] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [plan, setPlan] = useState('none');
  const [identifierError, setIdentifierError] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: (body: CreateSubjectBody) =>
      apiFetch<SubjectView>(`/admin/tenants/${tenantId}/users`, { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-users', tenantId] });
      onOpenChange(false);
      setExternalId('');
      setEmail('');
      setDisplayName('');
      setPlan('none');
    },
  });

  const submit = () => {
    if (externalId.trim() === '' && email.trim() === '') {
      setIdentifierError(t('tenantsAdmin.identifierRequired'));
      return;
    }
    setIdentifierError(undefined);
    create.mutate({
      ...(externalId.trim() !== '' ? { externalId: externalId.trim() } : {}),
      ...(email.trim() !== '' ? { email: email.trim() } : {}),
      ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
      ...(plan !== 'none' ? { limitPlanId: plan } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.createSubjectTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.createSubjectDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField
            label={t('tenantsAdmin.colExternalId')}
            hint={t('tenantsAdmin.externalIdHint')}
            error={identifierError}
          >
            {(id) => (
              <Input
                id={id}
                value={externalId}
                onChange={(event) => setExternalId(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.emailLabel')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.displayNameLabel')}>
            {(id) => (
              <Input
                id={id}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.limitPlan')}>
            {(id) => (
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger id={id} aria-label={t('tenantsAdmin.limitPlan')}>
                  <SelectValue />
                </SelectTrigger>
                <PlanSelectItems plans={plans} />
              </Select>
            )}
          </FormField>
          <MutationErrorText error={create.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? t('common.loading') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSubjectDialog({
  tenantId,
  subject,
  plans,
  onClose,
}: {
  tenantId: string;
  subject: SubjectView;
  plans: LimitPlanView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(subject.email ?? '');
  const [displayName, setDisplayName] = useState(subject.display_name ?? '');
  const [plan, setPlan] = useState(subject.limit_plan_id ?? 'none');
  const [status, setStatus] = useState<'active' | 'disabled'>(
    subject.status === 'disabled' ? 'disabled' : 'active',
  );

  const update = useMutation({
    mutationFn: (body: UpdateSubjectBody) =>
      apiFetch<SubjectView>(`/admin/tenants/${tenantId}/users/${subject.id}`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-users', tenantId] });
      onClose();
    },
  });

  const submit = () => {
    update.mutate({
      email: email.trim() === '' ? null : email.trim(),
      displayName: displayName.trim() === '' ? null : displayName.trim(),
      limitPlanId: plan === 'none' ? null : plan,
      status,
    });
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantsAdmin.editSubjectTitle')}</DialogTitle>
          <DialogDescription>{t('tenantsAdmin.editSubjectDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <DetailList
            items={[
              {
                label: t('tenantsAdmin.colExternalId'),
                value: <span className="font-mono text-sm">{subject.external_id ?? '—'}</span>,
              },
            ]}
          />
          <FormField label={t('tenantsAdmin.emailLabel')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.displayNameLabel')}>
            {(id) => (
              <Input
                id={id}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantsAdmin.limitPlan')}>
            {(id) => (
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger id={id} aria-label={t('tenantsAdmin.limitPlan')}>
                  <SelectValue />
                </SelectTrigger>
                <PlanSelectItems plans={plans} />
              </Select>
            )}
          </FormField>
          <FormField label={t('common.status')}>
            {(id) => (
              <Select
                value={status}
                onValueChange={(next) => setStatus(next === 'disabled' ? 'disabled' : 'active')}
              >
                <SelectTrigger id={id} aria-label={t('common.status')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('common.active')}</SelectItem>
                  <SelectItem value="disabled">{t('common.disabled')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <MutationErrorText error={update.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={update.isPending}>
            {update.isPending ? t('common.loading') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----- sub-wallet sheet -----

function SubWalletSheet({
  tenantId,
  subject,
  onClose,
}: {
  tenantId: string;
  subject: SubjectView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const base = `/admin/tenants/${tenantId}/users/${subject.id}/sub-account`;
  const key = ['admin', 'sub-account', tenantId, subject.id] as const;
  const [topupAmount, setTopupAmount] = useState('');
  const [topupError, setTopupError] = useState<string | undefined>(undefined);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferError, setTransferError] = useState<string | undefined>(undefined);
  const [direction, setDirection] = useState<'to_subject' | 'to_tenant'>('to_subject');

  const subAccount = useQuery({
    queryKey: key,
    queryFn: async (): Promise<SubAccountView | null> => {
      try {
        return await apiFetch<SubAccountView>(base);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-account', tenantId] });
  };

  const openWallet = useMutation({
    mutationFn: () => apiFetch<SubAccountView>(base, { method: 'POST', body: {} }),
    onSuccess: invalidate,
  });

  const topup = useMutation({
    mutationFn: (credits: number) =>
      apiFetch<SubAccountView>(`${base}/topup`, { method: 'POST', body: { credits } }),
    onSuccess: () => {
      invalidate();
      setTopupAmount('');
    },
  });

  const transfer = useMutation({
    mutationFn: (body: TransferCreditsBody) =>
      apiFetch<SubAccountView>(`${base}/transfer`, { method: 'POST', body }),
    onSuccess: () => {
      invalidate();
      setTransferAmount('');
    },
  });

  const submitTopup = () => {
    const credits = positiveNumber(topupAmount);
    if (credits === null) {
      setTopupError(t('tenantsAdmin.numberInvalid'));
      return;
    }
    setTopupError(undefined);
    topup.mutate(credits);
  };

  const submitTransfer = () => {
    const credits = positiveNumber(transferAmount);
    if (credits === null) {
      setTransferError(t('tenantsAdmin.numberInvalid'));
      return;
    }
    setTransferError(undefined);
    transfer.mutate({ credits, direction });
  };

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full max-w-md">
        <SheetHeader>
          <SheetTitle>
            {t('tenantsAdmin.subWallet')} ·{' '}
            {subject.display_name ?? subject.external_id ?? subject.email ?? subject.id.slice(0, 8)}
          </SheetTitle>
          <p className="text-sm text-muted-foreground">{t('tenantsAdmin.subWalletDescription')}</p>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-6">
          {subAccount.isLoading ? (
            <ResourceLoading rows={3} />
          ) : subAccount.isError ? (
            <ApiErrorNotice
              error={toApiStateError(subAccount.error)}
              onRetry={() => void subAccount.refetch()}
            />
          ) : subAccount.data === null ? (
            <div className="rounded-xl bg-surface-subtle p-5 text-center">
              <h3 className="text-sm font-semibold">{t('tenantsAdmin.sharedTitle')}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t('tenantsAdmin.sharedDescription')}
              </p>
              <Button
                className="mt-4"
                onClick={() => openWallet.mutate()}
                disabled={openWallet.isPending}
              >
                {openWallet.isPending ? t('common.loading') : t('tenantsAdmin.openSubWallet')}
              </Button>
              <MutationErrorText error={openWallet.error} />
            </div>
          ) : subAccount.data ? (
            <>
              <DetailList
                items={[
                  {
                    label: t('tenantsAdmin.balance'),
                    value: <MoneyText value={subAccount.data.credit_balance} />,
                  },
                  {
                    label: t('tenantsAdmin.held'),
                    value: <MoneyText value={subAccount.data.credit_held} />,
                  },
                  {
                    label: t('common.status'),
                    value: (
                      <Badge variant={subjectStatusVariant[subAccount.data.status] ?? 'neutral'}>
                        {subAccount.data.status === 'active'
                          ? t('common.active')
                          : t('common.disabled')}
                      </Badge>
                    ),
                  },
                  {
                    label: t('common.createdAt'),
                    value: <DateTimeText value={subAccount.data.created_at} />,
                  },
                ]}
              />

              <div className="space-y-3 border-t border-border/60 pt-4">
                <h3 className="text-sm font-semibold">{t('tenantsAdmin.topup')}</h3>
                <FormField label={t('tenantsAdmin.topupAmount')} error={topupError}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      value={topupAmount}
                      onChange={(event) => setTopupAmount(event.target.value)}
                    />
                  )}
                </FormField>
                <MutationErrorText error={topup.error} />
                <Button size="sm" onClick={submitTopup} disabled={topup.isPending}>
                  {topup.isPending ? t('common.loading') : t('tenantsAdmin.topup')}
                </Button>
              </div>

              <div className="space-y-3 border-t border-border/60 pt-4">
                <h3 className="text-sm font-semibold">{t('tenantsAdmin.transfer')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('tenantsAdmin.transferDescription')}
                </p>
                <FormField label={t('tenantsAdmin.transferDirection')}>
                  {(id) => (
                    <Select
                      value={direction}
                      onValueChange={(next) =>
                        setDirection(next === 'to_tenant' ? 'to_tenant' : 'to_subject')
                      }
                    >
                      <SelectTrigger id={id} aria-label={t('tenantsAdmin.transferDirection')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="to_subject">{t('tenantsAdmin.dirToSubject')}</SelectItem>
                        <SelectItem value="to_tenant">{t('tenantsAdmin.dirToTenant')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField label={t('tenantsAdmin.transferAmount')} error={transferError}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      value={transferAmount}
                      onChange={(event) => setTransferAmount(event.target.value)}
                    />
                  )}
                </FormField>
                <MutationErrorText error={transfer.error} />
                <Button size="sm" onClick={submitTransfer} disabled={transfer.isPending}>
                  {transfer.isPending ? t('common.loading') : t('tenantsAdmin.transfer')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ----- page -----

export function TenantDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const tenantId = id ?? '';
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [createSubjectOpen, setCreateSubjectOpen] = useState(false);
  const [editSubject, setEditSubject] = useState<SubjectView | null>(null);
  const [deleteSubject, setDeleteSubject] = useState<SubjectView | null>(null);
  const [walletSubject, setWalletSubject] = useState<SubjectView | null>(null);

  const tenant = useQuery({
    queryKey: ['admin', 'tenant', tenantId],
    queryFn: () => apiFetch<TenantView>(`/admin/tenants/${tenantId}`),
    enabled: tenantId !== '',
  });

  // `/admin/accounts` has no tenant filter — walk the cursor pages and pick the
  // account whose tenant_id matches (one account per tenant).
  const account = useQuery({
    queryKey: ['admin', 'tenant-account', tenantId],
    queryFn: async (): Promise<AccountView | null> => {
      let cursor: string | undefined;
      for (let page = 0; page < 40; page += 1) {
        const envelope = await apiFetch<PageOf<AccountView>>('/admin/accounts', {
          query: { cursor, limit: 100 },
        });
        const hit = envelope.data.find((row) => row.tenant_id === tenantId);
        if (hit) return hit;
        if (!envelope.has_more || !envelope.next_cursor) return null;
        cursor = envelope.next_cursor;
      }
      return null;
    },
    enabled: tenantId !== '',
  });

  const plans = useQuery({
    queryKey: ['admin', 'limit-plans'],
    queryFn: () => apiFetch<LimitPlanView[]>('/admin/limit-plans'),
  });
  const planList = plans.data ?? [];
  const planName = (planId: string | null) => {
    if (!planId) return null;
    return planList.find((plan) => plan.id === planId)?.name ?? planId.slice(0, 8);
  };

  const subjects = useCursorQuery<SubjectView>({
    key: ['admin', 'tenant-users', tenantId],
    path: `/admin/tenants/${tenantId}/users`,
    limit: 50,
    enabled: tenantId !== '',
  });

  const createAccount = useMutation({
    mutationFn: () =>
      apiFetch<AccountView>('/admin/accounts', { method: 'POST', body: { tenantId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-account', tenantId] });
    },
  });

  const removeSubject = useMutation({
    mutationFn: (sid: string) =>
      apiFetch<unknown>(`/admin/tenants/${tenantId}/users/${sid}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-users', tenantId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant-account', tenantId] });
      setDeleteSubject(null);
    },
  });

  return (
    <PageTransition>
      <PageHeader
        title={tenant.data?.name ?? t('tenantsAdmin.title')}
        description={t('tenantsAdmin.detailDescription')}
        actions={
          <Button variant="outline" asChild>
            <Link to="/console/tenants">
              <ArrowLeft />
              {t('tenantsAdmin.backToList')}
            </Link>
          </Button>
        }
      />

      {tenant.isLoading ? (
        <ResourceLoading rows={4} />
      ) : tenant.isError ? (
        <ApiErrorNotice
          error={toApiStateError(tenant.error)}
          onRetry={() => void tenant.refetch()}
        />
      ) : tenant.data ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">{t('tenantsAdmin.infoTitle')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('tenantsAdmin.infoDescription')}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil />
                  {t('common.edit')}
                </Button>
              </div>
              <DetailList
                items={[
                  { label: t('common.name'), value: tenant.data.name },
                  {
                    label: t('common.id'),
                    value: (
                      <span className="inline-flex items-center gap-1">
                        <span className="font-mono text-sm">{tenant.data.id}</span>
                        <CopyButton value={tenant.data.id} />
                      </span>
                    ),
                  },
                  {
                    label: t('tenantsAdmin.colIsolation'),
                    value: (
                      <Badge variant="neutral">
                        {t(ISOLATION_KEYS[tenant.data.isolation_mode] ?? 'common.none')}
                      </Badge>
                    ),
                  },
                  {
                    label: t('common.createdAt'),
                    value: <DateTimeText value={tenant.data.created_at} />,
                  },
                ]}
              />
            </Card>

            <Card className="p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">{t('tenantsAdmin.walletTitle')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('tenantsAdmin.walletDescription')}
                  </p>
                </div>
                {account.data ? (
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => setBindOpen(true)}>
                      {t('tenantsAdmin.bindPlan')}
                    </Button>
                    <Button size="sm" onClick={() => setTopupOpen(true)}>
                      <Wallet />
                      {t('tenantsAdmin.topup')}
                    </Button>
                  </div>
                ) : null}
              </div>
              {account.isLoading ? (
                <ResourceLoading rows={3} />
              ) : account.isError ? (
                <ApiErrorNotice
                  error={toApiStateError(account.error)}
                  onRetry={() => void account.refetch()}
                />
              ) : account.data ? (
                <DetailList
                  items={[
                    {
                      label: t('tenantsAdmin.balance'),
                      value: <MoneyText value={account.data.credit_balance} />,
                    },
                    {
                      label: t('tenantsAdmin.held'),
                      value: <MoneyText value={account.data.credit_held} />,
                    },
                    {
                      label: t('tenantsAdmin.accountId'),
                      value: (
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-sm">{account.data.id.slice(0, 8)}</span>
                          <CopyButton value={account.data.id} />
                        </span>
                      ),
                    },
                    {
                      label: t('tenantsAdmin.limitPlan'),
                      value: planName(account.data.limit_plan_id) ?? (
                        <span className="text-muted-foreground">
                          {t('tenantsAdmin.planUnbound')}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : (
                <div className="py-6 text-center">
                  <h3 className="text-sm font-semibold">{t('tenantsAdmin.noAccountTitle')}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {t('tenantsAdmin.noAccountDescription')}
                  </p>
                  <Button
                    className="mt-4"
                    size="sm"
                    onClick={() => createAccount.mutate()}
                    disabled={createAccount.isPending}
                  >
                    {createAccount.isPending ? t('common.loading') : t('tenantsAdmin.openAccount')}
                  </Button>
                  <MutationErrorText error={createAccount.error} />
                </div>
              )}
            </Card>
          </div>

          <Card className="mt-6">
            <DataTableToolbar
              title={t('tenantsAdmin.subjectsTitle')}
              onRefresh={() => void subjects.refetch()}
              refreshing={subjects.isRefetching}
            >
              <Button size="sm" className="ml-auto" onClick={() => setCreateSubjectOpen(true)}>
                {t('tenantsAdmin.createSubject')}
              </Button>
            </DataTableToolbar>
            {subjects.isLoading ? (
              <div className="p-4">
                <ResourceLoading rows={4} />
              </div>
            ) : subjects.isError ? (
              <ApiErrorNotice
                className="m-4"
                error={toApiStateError(subjects.error)}
                onRetry={() => void subjects.refetch()}
              />
            ) : subjects.rows.length === 0 ? (
              <EmptyState
                icon={Users}
                title={t('tenantsAdmin.subjectsEmptyTitle')}
                description={t('tenantsAdmin.subjectsEmptyDescription')}
                action={
                  <Button size="sm" onClick={() => setCreateSubjectOpen(true)}>
                    {t('tenantsAdmin.createSubject')}
                  </Button>
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <DataTable>
                    <DataTableHeader>
                      <DataTableRow>
                        <DataTableHead>{t('tenantsAdmin.colExternalId')}</DataTableHead>
                        <DataTableHead>{t('tenantsAdmin.colEmail')}</DataTableHead>
                        <DataTableHead>{t('tenantsAdmin.colDisplayName')}</DataTableHead>
                        <DataTableHead>{t('tenantsAdmin.colPlan')}</DataTableHead>
                        <DataTableHead>{t('common.status')}</DataTableHead>
                        <DataTableHead>{t('common.createdAt')}</DataTableHead>
                        <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                      </DataTableRow>
                    </DataTableHeader>
                    <DataTableBody>
                      {subjects.rows.map((row) => (
                        <DataTableRow key={row.id}>
                          <DataTableCell className="font-mono text-sm">
                            {row.external_id ?? '—'}
                          </DataTableCell>
                          <DataTableCell>{row.email ?? '—'}</DataTableCell>
                          <DataTableCell>{row.display_name ?? '—'}</DataTableCell>
                          <DataTableCell>{planName(row.limit_plan_id) ?? '—'}</DataTableCell>
                          <DataTableCell>
                            <Badge variant={subjectStatusVariant[row.status] ?? 'neutral'}>
                              {row.status === 'active' ? t('common.active') : t('common.disabled')}
                            </Badge>
                          </DataTableCell>
                          <DataTableCell>
                            <DateTimeText value={row.created_at} />
                          </DataTableCell>
                          <DataTableCell className="text-right">
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('tenantsAdmin.subWallet')}
                                onClick={() => setWalletSubject(row)}
                              >
                                <Wallet />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('common.edit')}
                                onClick={() => setEditSubject(row)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('common.delete')}
                                onClick={() => setDeleteSubject(row)}
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

          <EditTenantDialog tenant={tenant.data} open={editOpen} onOpenChange={setEditOpen} />
          {account.data ? (
            <>
              <TopupDialog
                accountId={account.data.id}
                tenantId={tenantId}
                open={topupOpen}
                onOpenChange={setTopupOpen}
              />
              {bindOpen ? (
                <BindPlanDialog
                  tenantId={tenantId}
                  currentPlanId={account.data.limit_plan_id}
                  plans={planList}
                  open={bindOpen}
                  onOpenChange={setBindOpen}
                />
              ) : null}
            </>
          ) : null}
          <CreateSubjectDialog
            tenantId={tenantId}
            plans={planList}
            open={createSubjectOpen}
            onOpenChange={setCreateSubjectOpen}
          />
          {editSubject ? (
            <EditSubjectDialog
              tenantId={tenantId}
              subject={editSubject}
              plans={planList}
              onClose={() => setEditSubject(null)}
            />
          ) : null}
          {deleteSubject ? (
            <ConfirmDialog
              open
              onOpenChange={(next) => (next ? undefined : setDeleteSubject(null))}
              title={t('tenantsAdmin.deleteSubjectTitle')}
              description={t('tenantsAdmin.deleteSubjectDescription')}
              confirmLabel={t('common.delete')}
              pending={removeSubject.isPending}
              onConfirm={() => removeSubject.mutate(deleteSubject.id)}
            />
          ) : null}
          {walletSubject ? (
            <SubWalletSheet
              tenantId={tenantId}
              subject={walletSubject}
              onClose={() => setWalletSubject(null)}
            />
          ) : null}
        </>
      ) : null}
    </PageTransition>
  );
}
