import { ArrowLeftIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { useSetConsoleBack } from '../../components/console/ConsoleChrome';
import { BalanceCard } from '../../components/data/BalanceCard';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { ErrorState } from '../../components/data/ErrorState';
import { LimitUsageBars } from '../../components/data/LimitUsageBars';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { NumberField } from '../../components/ui/NumberField';
import { RoseLoader } from '../../components/ui/RoseLoader';
import { SelectField } from '../../components/ui/SelectField';
import { Tabs } from '../../components/ui/Tabs';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type {
  AccountView,
  LedgerView,
  PaymentIntentView,
  SubjectView,
  TenantView,
} from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { SubjectDetailPanel } from './SubjectDetailPanel';

/**
 * The routed tenant detail page (`/console/tenants/:id`) — the full-page successor
 * to the former `TenantDetailDrawer`. Identity (copyable id, isolation, created)
 * plus the tenant's account (balance/held via the joined accounts list), inline
 * top-up + governance plan binding, and the End-users / Ledger / Payments tabs.
 * The tenant + account are resolved from the shared list queries by `:id`, so
 * account writes invalidate the same accounts list the directory table reads.
 */
export function TenantDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('console');
  const api = useAdminApi();

  useSetConsoleBack({ to: '/console/tenants', label: t('tenants.title') });

  // Reuse the directory's list queries (no get-by-id endpoint); resolve by :id.
  const tenants = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
  });
  const accounts = useQuery({
    queryKey: qk.accounts(),
    queryFn: () => api.listAccounts(),
    staleTime: STALE_REFERENCE,
  });

  const tenant = (tenants.data ?? []).find((x) => x.id === id);
  const account = (accounts.data ?? []).find((a) => a.tenant_id === id);

  if (tenants.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-6)' }}>
        <RoseLoader size={56} />
      </div>
    );
  }
  if (tenants.isError) {
    return (
      <div style={{ padding: 'var(--s-5)' }}>
        <ErrorState onRetry={() => void tenants.refetch()} />
      </div>
    );
  }
  if (tenant === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <BackLink label={t('tenants.detail.back')} />
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-5)',
            color: 'var(--muted)',
            fontSize: 'var(--fs-sm)',
            textAlign: 'center',
          }}
        >
          {t('tenants.detail.notFound')}
        </div>
      </div>
    );
  }

  return (
    <TenantDetailBody
      tenant={tenant}
      account={account}
      accountsLoading={accounts.isLoading}
      accountsError={accounts.isError}
      onRetryAccounts={() => void accounts.refetch()}
    />
  );
}

/** The page's top-of-content back link (mirrors the TopBar back slot for an in-page affordance). */
function BackLink({ label }: { label: string }) {
  return (
    <Link
      to="/console/tenants"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--muted)',
        textDecoration: 'none',
        width: 'fit-content',
      }}
    >
      <ArrowLeftIcon size={14} weight="bold" aria-hidden="true" />
      {label}
    </Link>
  );
}

/** One label / value row in the tenant detail header. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 'var(--fs-sm)' }}>{children}</span>
    </div>
  );
}

/**
 * The detail body — the former drawer content, now a page. Identity + account
 * (balance/held + inline top-up + 额度套餐 binding/usage) and the lazy
 * End-users / Ledger / Payments tabs. Inline forms (not modals) match the former
 * drawer's no-nested-focus-trap layout.
 */
function TenantDetailBody({
  tenant,
  account,
  accountsLoading,
  accountsError,
  onRetryAccounts,
}: {
  tenant: TenantView;
  account: AccountView | undefined;
  accountsLoading: boolean;
  accountsError: boolean;
  onRetryAccounts: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tab, setTab] = useState('account');
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCredits, setTopupCredits] = useState(0);
  const [openingCredits, setOpeningCredits] = useState(0);

  const refreshAccounts = () => qc.invalidateQueries({ queryKey: qk.accounts() });

  // Limit plans drive the tenant-level governance binding (额度套餐, on the account).
  const plans = useQuery({
    queryKey: qk.limitPlans(),
    queryFn: () => api.listLimitPlans(),
    staleTime: STALE_REFERENCE,
  });
  const planOptions = (plans.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const planId = account?.limit_plan_id ?? null;
  // Usage-vs-cap for the bound tenant plan (rolling-aware).
  const usage = useQuery({
    queryKey: qk.limitStatus('tenant', tenant.id),
    queryFn: () => api.listLimitStatus('tenant', tenant.id, planId ?? ''),
    enabled: planId !== null,
    staleTime: 30_000,
  });

  const bindPlan = useMutation({
    mutationFn: (pid: string | null) => api.setTenantLimitPlan(tenant.id, pid),
    onSuccess: async () => {
      await Promise.all([
        refreshAccounts(),
        qc.invalidateQueries({ queryKey: qk.limitStatus('tenant', tenant.id) }),
      ]);
      toast(t('tenants.detail.planBound'));
    },
    onError: mutationError(t),
  });

  // Edit the only mutable tenant field (isolation mode) — applied on select.
  const updateTenant = useMutation({
    mutationFn: (isolationMode: 'field' | 'schema' | 'db') =>
      api.updateTenant(tenant.id, { isolationMode }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.tenants() });
      toast(t('tenants.updated'));
    },
    onError: mutationError(t),
  });

  const topup = useMutation({
    mutationFn: () => api.topup(account?.id ?? '', { credits: topupCredits }),
    onSuccess: async () => {
      await refreshAccounts();
      toast(t('accounts.topup.done'));
      setTopupOpen(false);
      setTopupCredits(0);
    },
    onError: mutationError(t),
  });

  const createAccount = useMutation({
    mutationFn: () =>
      api.createAccount({
        tenantId: tenant.id,
        credits: openingCredits > 0 ? openingCredits : undefined,
      }),
    onSuccess: async () => {
      await refreshAccounts();
      toast(t('accounts.created'));
      setOpeningCredits(0);
    },
    onError: mutationError(t),
  });

  // Ledger + payments tabs lazy-load (only the open tab queries).
  const ledger = useQuery({
    queryKey: qk.ledger(tenant.id),
    queryFn: () => api.listLedger({ tenantId: tenant.id, limit: 50 }),
    enabled: tab === 'ledger',
  });
  const payments = useQuery({
    queryKey: qk.payments(tenant.id),
    queryFn: () => api.listPayments(tenant.id, 50),
    enabled: tab === 'payments',
  });

  // Subjects (end-users; unified tenancy G-A) — lazy-loaded with the tab.
  const [newExtId, setNewExtId] = useState('');
  const [newName, setNewName] = useState('');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const subjects = useQuery({
    queryKey: qk.subjects(tenant.id),
    queryFn: () => api.listSubjects(tenant.id),
    enabled: tab === 'users',
  });
  const refreshSubjects = () => qc.invalidateQueries({ queryKey: qk.subjects(tenant.id) });
  const createSubject = useMutation({
    mutationFn: () =>
      api.createSubject(tenant.id, {
        externalId: newExtId.trim(),
        ...(newName.trim() !== '' ? { displayName: newName.trim() } : {}),
      }),
    onSuccess: async () => {
      await refreshSubjects();
      toast(t('tenants.detail.users.created'));
      setNewExtId('');
      setNewName('');
    },
    onError: mutationError(t),
  });
  const toggleSubject = useMutation({
    mutationFn: (s: SubjectView) =>
      api.updateSubject(tenant.id, s.id, {
        status: s.status === 'active' ? 'disabled' : 'active',
      }),
    onSuccess: () => refreshSubjects(),
    onError: mutationError(t),
  });
  const removeSubject = useMutation({
    mutationFn: (sid: string) => api.deleteSubject(tenant.id, sid),
    onSuccess: async () => {
      await refreshSubjects();
      toast(t('tenants.detail.users.deleted'));
    },
    onError: mutationError(t),
  });

  const selectedSubject = (subjects.data ?? []).find((s) => s.id === selectedSubjectId);

  const subjectCols: Column<SubjectView>[] = [
    {
      key: 'identity',
      header: t('tenants.detail.users.cols.identity'),
      grow: true,
      cell: (r) => r.external_id ?? r.email ?? r.id,
    },
    {
      key: 'name',
      header: t('tenants.detail.users.cols.name'),
      cell: (r) => r.display_name ?? '—',
      width: '128px',
    },
    {
      key: 'status',
      header: t('tenants.detail.users.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '88px',
    },
    {
      key: 'actions',
      header: '',
      noClip: true,
      width: '150px',
      cell: (r) => (
        <div
          style={{ display: 'flex', gap: 'var(--s-1)' }}
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <Button variant="ghost" size="sm" onClick={() => toggleSubject.mutate(r)}>
            {r.status === 'active' ? t('common.disable') : t('common.enable')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => removeSubject.mutate(r.id)}>
            {t('common.delete')}
          </Button>
        </div>
      ),
    },
  ];

  const ledgerCols: Column<LedgerView>[] = [
    {
      key: 'time',
      header: t('tenants.detail.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '104px',
    },
    { key: 'type', header: t('tenants.detail.cols.type'), grow: true, cell: (r) => r.type },
    {
      key: 'subject',
      header: t('tenants.detail.cols.subject'),
      cell: (r) =>
        r.subject_id === null ? (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ) : (
          <span className="mono" style={{ fontSize: 'var(--fs-caption)' }} title={r.subject_id}>
            {r.subject_id.slice(0, 8)}
          </span>
        ),
      width: '96px',
    },
    {
      key: 'delta',
      header: t('tenants.detail.cols.delta'),
      numeric: true,
      cell: (r) => <Money micro={r.credits_delta} />,
      width: '110px',
    },
    {
      key: 'balance',
      header: t('tenants.detail.cols.balanceAfter'),
      numeric: true,
      cell: (r) => <Money micro={r.balance_after} />,
      width: '110px',
    },
  ];
  const paymentCols: Column<PaymentIntentView>[] = [
    {
      key: 'time',
      header: t('tenants.detail.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '104px',
    },
    {
      key: 'provider',
      header: t('tenants.detail.cols.provider'),
      grow: true,
      cell: (r) => r.provider,
    },
    {
      key: 'amount',
      header: t('tenants.detail.cols.amount'),
      numeric: true,
      cell: (r) => (
        <span className="tabular">
          {(Number(r.amount_minor) / 100).toFixed(2)} {r.currency.toUpperCase()}
        </span>
      ),
      width: '120px',
    },
    {
      key: 'status',
      header: t('tenants.detail.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '104px',
    },
  ];

  const accountPanel = accountsLoading ? (
    <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-5)' }}>
      <RoseLoader size={48} />
    </div>
  ) : accountsError && account === undefined ? (
    // A missing account here is ambiguous when the accounts list failed to load —
    // it might exist but be unfetched. Show an error+retry instead of the
    // "no account, create one" form, which would misrepresent the state.
    <ErrorState message={t('tenants.detail.accountError')} onRetry={onRetryAccounts} />
  ) : account !== undefined ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <BalanceCard
        micro={account.credit_balance}
        label={t('accounts.cols.balance')}
        held={account.credit_held}
        heldLabel={t('accounts.cols.held')}
      />
      {topupOpen ? (
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-3)',
          }}
        >
          <NumberField
            label={t('accounts.topup.credits')}
            value={topupCredits}
            onChange={setTopupCredits}
            min={0}
          />
          <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
            <Button
              variant="cta"
              onClick={() => topup.mutate()}
              loading={topup.isPending}
              disabled={topupCredits <= 0}
            >
              {t('accounts.topup.submit')}
            </Button>
            <Button variant="ghost" onClick={() => setTopupOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" onClick={() => setTopupOpen(true)}>
          {t('accounts.topup.action')}
        </Button>
      )}

      {/* Governance: bind a 额度套餐 + show usage-vs-cap for the bound plan. */}
      <div
        className="panel"
        style={{
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-3)',
        }}
      >
        <SelectField
          label={t('tenants.detail.plan.label')}
          tooltip={t('tenants.detail.plan.tip')}
          value={planId ?? ''}
          onChange={(v) => bindPlan.mutate(v === '' ? null : v)}
          options={planOptions}
          placeholder={t('tenants.detail.plan.none')}
        />
        {planId !== null && <LimitUsageBars rules={usage.data ?? []} />}
      </div>
    </div>
  ) : (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-3)',
      }}
    >
      <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
        {t('tenants.detail.noAccount')}
      </span>
      <NumberField
        label={t('accounts.form.credits')}
        value={openingCredits}
        onChange={setOpeningCredits}
        min={0}
      />
      <Button variant="cta" onClick={() => createAccount.mutate()} loading={createAccount.isPending}>
        <PlusIcon size={14} weight="bold" /> {t('accounts.new')}
      </Button>
    </div>
  );

  const usersPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div
        className="panel"
        style={{
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-3)',
        }}
      >
        <TextField
          label={t('tenants.detail.users.form.externalId')}
          value={newExtId}
          onChange={setNewExtId}
        />
        <TextField
          label={t('tenants.detail.users.form.name')}
          value={newName}
          onChange={setNewName}
        />
        <Button
          variant="cta"
          onClick={() => createSubject.mutate()}
          loading={createSubject.isPending}
          disabled={newExtId.trim() === ''}
        >
          <PlusIcon size={14} weight="bold" /> {t('tenants.detail.users.add')}
        </Button>
      </div>
      <DataTable
        columns={subjectCols}
        rows={subjects.data ?? []}
        rowKey={(r) => r.id}
        loading={subjects.isLoading}
        error={subjects.isError}
        onRetry={() => void subjects.refetch()}
        empty={t('tenants.detail.users.empty')}
        onRowClick={(r) => setSelectedSubjectId((cur) => (cur === r.id ? null : r.id))}
        selectedKey={selectedSubjectId ?? undefined}
      />
      {selectedSubject !== undefined && (
        <SubjectDetailPanel
          key={selectedSubject.id}
          tenantId={tenant.id}
          subject={selectedSubject}
          planOptions={planOptions}
          onClose={() => setSelectedSubjectId(null)}
        />
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <BackLink label={t('tenants.detail.back')} />
      <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-medium)', margin: 0 }}>
        {tenant.name}
      </h1>

      <DetailRow label={t('tenants.detail.id')}>
        <CopyField
          value={tenant.id}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
          failedLabel={t('common.copyFailed')}
        />
      </DetailRow>
      <div style={{ maxWidth: 240 }}>
        <SelectField
          label={t('tenants.form.isolation')}
          value={tenant.isolation_mode}
          onChange={(v) => updateTenant.mutate(v as 'field' | 'schema' | 'db')}
          options={[
            { value: 'field', label: t('tenants.isolation.field') },
            { value: 'schema', label: t('tenants.isolation.schema') },
            { value: 'db', label: t('tenants.isolation.db') },
          ]}
        />
      </div>
      <DetailRow label={t('tenants.cols.created')}>
        {new Date(tenant.created_at).toLocaleString()}
      </DetailRow>

      <Tabs
        value={tab}
        onChange={setTab}
        ariaLabel={t('tenants.detail.tabsLabel')}
        tabs={[
          { value: 'account', label: t('tenants.detail.account') },
          { value: 'users', label: t('tenants.detail.users.tab') },
          { value: 'ledger', label: t('tenants.detail.ledger') },
          { value: 'payments', label: t('tenants.detail.payments') },
        ]}
      >
        {tab === 'account' ? (
          accountPanel
        ) : tab === 'users' ? (
          usersPanel
        ) : tab === 'ledger' ? (
          <DataTable
            columns={ledgerCols}
            rows={ledger.data?.rows ?? []}
            rowKey={(r) => r.id}
            loading={ledger.isLoading}
            error={ledger.isError}
            onRetry={() => void ledger.refetch()}
            empty={t('tenants.detail.noLedger')}
          />
        ) : (
          <DataTable
            columns={paymentCols}
            rows={payments.data?.rows ?? []}
            rowKey={(r) => r.id}
            loading={payments.isLoading}
            error={payments.isError}
            onRetry={() => void payments.refetch()}
            empty={t('tenants.detail.noPayments')}
          />
        )}
      </Tabs>
    </div>
  );
}
