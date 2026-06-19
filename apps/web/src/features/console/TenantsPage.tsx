import { BuildingsIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BalanceCard } from '../../components/data/BalanceCard';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { EntityCard } from '../../components/data/EntityCard';
import { Money } from '../../components/data/Money';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { RoseLoader } from '../../components/ui/RoseLoader';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { AccountView, TenantView } from '../../lib/api/types';
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

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('tenants.new')}
      </Button>
    ),
    [t],
  );

  return (
    <div style={{ height: '100%' }}>
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

      {selected !== null && (
        <TenantDetailDrawer
          tenant={selected}
          account={accountByTenant.get(selected.id)}
          accountsLoading={accounts.isLoading}
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
  onClose,
}: {
  tenant: TenantView;
  account: AccountView | undefined;
  accountsLoading: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCredits, setTopupCredits] = useState(0);
  const [openingCredits, setOpeningCredits] = useState(0);

  const refreshAccounts = () => qc.invalidateQueries({ queryKey: qk.accounts() });

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
        <DetailRow label={t('tenants.form.isolation')}>
          {t(`tenants.isolation.${tenant.isolation_mode}`, tenant.isolation_mode)}
        </DetailRow>
        <DetailRow label={t('tenants.cols.created')}>
          {new Date(tenant.created_at).toLocaleString()}
        </DetailRow>

        <SectionHeader title={t('tenants.detail.account')} />
        {accountsLoading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-5)' }}>
            <RoseLoader size={48} />
          </div>
        ) : account !== undefined ? (
          <>
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
          </>
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
            <Button
              variant="cta"
              onClick={() => createAccount.mutate()}
              loading={createAccount.isPending}
            >
              <PlusIcon size={14} weight="bold" /> {t('accounts.new')}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
