import { BuildingsIcon, PlusIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BalanceCard } from '../../components/data/BalanceCard';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { EntityCard } from '../../components/data/EntityCard';
import { ErrorState } from '../../components/data/ErrorState';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { Modal } from '../../components/ui/Modal';
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
  ProvisionView,
  TenantView,
} from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

/**
 * The tenant hub (租户中枢): a card grid of tenants where each card opens a detail
 * `Drawer`. The drawer absorbs the former standalone Accounts surface — it shows
 * the tenant's balance/held (joined from the accounts list by `tenant_id`), with
 * top-up and a create-account path. `/console/accounts` now redirects here.
 */
export function TenantsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const tenants = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
  });
  // Accounts are listed once and joined to tenants by tenant_id (1:1 in practice).
  const accounts = useQuery({
    queryKey: qk.accounts(),
    queryFn: () => api.listAccounts(),
    staleTime: STALE_REFERENCE,
  });
  const accountByTenant = useMemo(() => {
    const m = new Map<string, AccountView>();
    for (const a of accounts.data ?? []) if (!m.has(a.tenant_id)) m.set(a.tenant_id, a);
    return m;
  }, [accounts.data]);

  const [selected, setSelected] = useState<TenantView | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState('field');

  // Provision (atomic onboarding): tenant + account + key in one call. The
  // result holds the minted key plaintext, shown ONCE in a follow-up dialog.
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [pName, setPName] = useState('');
  const [pCredits, setPCredits] = useState(0);
  const [pIsolation, setPIsolation] = useState('field');
  const [provisioned, setProvisioned] = useState<ProvisionView | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createTenant({ name, isolationMode: isolation as 'field' | 'schema' | 'db' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.tenants() });
      toast(t('tenants.created'));
      setOpen(false);
      setName('');
    },
    onError: mutationError(t),
  });

  const provision = useMutation({
    mutationFn: () =>
      api.provision({
        name: pName,
        isolationMode: pIsolation as 'field' | 'schema' | 'db',
        credits: pCredits > 0 ? pCredits : undefined,
      }),
    onSuccess: async (res) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.tenants() }),
        qc.invalidateQueries({ queryKey: qk.accounts() }),
      ]);
      toast(t('tenants.provision.done'));
      setProvisionOpen(false);
      setPName('');
      setPCredits(0);
      setProvisioned(res); // surface the one-time key
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <>
        <Button variant="ghost" onClick={() => setProvisionOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('tenants.provision.action')}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('tenants.new')}
        </Button>
      </>
    ),
    [t],
  );

  return (
    <div style={{ height: '100%' }}>
      {/* Tenants load independently of accounts. If the accounts list fails, the
          tenant cards still render but every balance falls back to "—"; surface
          a compact notice so that gap reads as an error, not as "zero credits". */}
      {accounts.isError && (
        <div
          role="alert"
          className="panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-3)',
            padding: 'var(--s-3) var(--s-4)',
            marginBottom: 'var(--s-3)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text)',
          }}
        >
          <WarningCircleIcon
            size={18}
            weight="regular"
            style={{ color: 'var(--fail)', flexShrink: 0 }}
            aria-hidden="true"
          />
          <span style={{ flex: 1 }}>{t('tenants.balancesError')}</span>
          <Button variant="ghost" size="sm" onClick={() => void accounts.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      <CardCollection
        rows={tenants.data ?? []}
        loading={tenants.isLoading}
        error={tenants.isError}
        onRetry={() => void tenants.refetch()}
        empty={t('tenants.empty')}
        renderCard={(r) => {
          const acct = accountByTenant.get(r.id);
          return (
            <EntityCard
              key={r.id}
              icon={BuildingsIcon}
              title={r.name}
              onClick={() => setSelected(r)}
              selected={selected?.id === r.id}
              chips={[t(`tenants.isolation.${r.isolation_mode}`, r.isolation_mode)]}
              meta={[
                {
                  label: t('tenants.cols.created'),
                  value: new Date(r.created_at).toLocaleDateString(),
                },
                {
                  label: t('accounts.cols.balance'),
                  value: acct ? <Money micro={acct.credit_balance} /> : '—',
                },
              ]}
            />
          );
        }}
      />

      <Modal
        open={open}
        title={t('tenants.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()} loading={create.isPending}>
            {t('tenants.submit')}
          </Button>
        }
      >
        <TextField label={t('tenants.form.name')} value={name} onChange={setName} />
        <SelectField
          label={t('tenants.form.isolation')}
          value={isolation}
          onChange={setIsolation}
          options={[
            { value: 'field', label: t('tenants.isolation.field') },
            { value: 'schema', label: t('tenants.isolation.schema') },
            { value: 'db', label: t('tenants.isolation.db') },
          ]}
        />
      </Modal>

      {/* Provision: tenant + account + first API key atomically. */}
      <Modal
        open={provisionOpen}
        title={t('tenants.provision.title')}
        onClose={() => setProvisionOpen(false)}
        footer={
          <Button
            variant="cta"
            onClick={() => provision.mutate()}
            loading={provision.isPending}
            disabled={pName.trim() === ''}
          >
            {t('tenants.provision.submit')}
          </Button>
        }
      >
        <TextField label={t('tenants.form.name')} value={pName} onChange={setPName} />
        <NumberField
          label={t('tenants.provision.credits')}
          value={pCredits}
          onChange={setPCredits}
          min={0}
        />
        <SelectField
          label={t('tenants.form.isolation')}
          value={pIsolation}
          onChange={setPIsolation}
          options={[
            { value: 'field', label: t('tenants.isolation.field') },
            { value: 'schema', label: t('tenants.isolation.schema') },
            { value: 'db', label: t('tenants.isolation.db') },
          ]}
        />
      </Modal>

      {/* One-time reveal of the provisioned key (never shown again). */}
      <Modal
        open={provisioned !== null}
        title={t('tenants.provision.keyTitle')}
        onClose={() => setProvisioned(null)}
        footer={
          <Button variant="cta" onClick={() => setProvisioned(null)}>
            {t('common.confirm')}
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <span style={{ color: 'var(--fail)', fontSize: 'var(--fs-sm)' }}>
            {t('tenants.provision.keyHint')}
          </span>
          {provisioned !== null && (
            <CopyField
              value={provisioned.api_key.plaintext}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
              failedLabel={t('common.copyFailed')}
            />
          )}
        </div>
      </Modal>

      {selected !== null && (
        <TenantDetailDrawer
          tenant={selected}
          account={accountByTenant.get(selected.id)}
          accountsLoading={accounts.isLoading}
          accountsError={accounts.isError}
          onRetryAccounts={() => void accounts.refetch()}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** One label / value row in the tenant detail drawer. */
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
 * The tenant hub's detail drawer: identity (copyable id, isolation, created) plus
 * the tenant's account — balance/held via the joined `account` (the merged-in
 * Accounts surface), with inline top-up, and a create-account path when the tenant
 * has none yet. Account writes invalidate the shared accounts list so the card grid
 * and drawer stay in sync. Inline forms (not nested modals) avoid stacking a second
 * focus trap inside the drawer.
 */
function TenantDetailDrawer({
  tenant,
  account,
  accountsLoading,
  accountsError,
  onRetryAccounts,
  onClose,
}: {
  tenant: TenantView;
  account: AccountView | undefined;
  accountsLoading: boolean;
  accountsError: boolean;
  onRetryAccounts: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tab, setTab] = useState('account');
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCredits, setTopupCredits] = useState(0);
  const [openingCredits, setOpeningCredits] = useState(0);

  const refreshAccounts = () => qc.invalidateQueries({ queryKey: qk.accounts() });

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

  // Ledger + payments tabs lazy-load (only the open tab queries) — wiring the
  // previously zero-call admin.ts listLedger/listPayments into the hub.
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

  const ledgerCols: Column<LedgerView>[] = [
    {
      key: 'time',
      header: t('tenants.detail.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '104px',
    },
    { key: 'type', header: t('tenants.detail.cols.type'), grow: true, cell: (r) => r.type },
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
    { key: 'provider', header: t('tenants.detail.cols.provider'), grow: true, cell: (r) => r.provider },
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

  return (
    <Drawer open title={tenant.name} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
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
            { value: 'ledger', label: t('tenants.detail.ledger') },
            { value: 'payments', label: t('tenants.detail.payments') },
          ]}
        >
          {tab === 'account' ? (
            accountPanel
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
    </Drawer>
  );
}
