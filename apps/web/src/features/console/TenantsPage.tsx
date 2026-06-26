import { PlusIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Money } from '../../components/data/Money';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { AccountView, ProvisionView, TenantView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

/**
 * The tenant directory (租户中枢): a `DataTable` of tenants — name, isolation mode,
 * created, and the joined account balance (from the accounts list by `tenant_id`).
 * Row-click navigates to the routed `/console/tenants/:id` detail page (the former
 * detail drawer). `/console/accounts` redirects here.
 */
export function TenantsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

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

  const cols: Column<TenantView>[] = [
    {
      key: 'name',
      header: t('tenants.cols.name'),
      grow: true,
      cell: (r) => r.name,
    },
    {
      key: 'isolation',
      header: t('tenants.cols.isolation'),
      noClip: true,
      width: '140px',
      cell: (r) => (
        <span className="chip">{t(`tenants.isolation.${r.isolation_mode}`, r.isolation_mode)}</span>
      ),
    },
    {
      key: 'created',
      header: t('tenants.cols.created'),
      align: 'right',
      width: '140px',
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
    },
    {
      key: 'balance',
      header: t('accounts.cols.balance'),
      numeric: true,
      width: '140px',
      cell: (r) => {
        const acct = accountByTenant.get(r.id);
        return acct ? <Money micro={acct.credit_balance} /> : '—';
      },
    },
  ];

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
      <DataTable
        columns={cols}
        rows={tenants.data ?? []}
        rowKey={(r) => r.id}
        loading={tenants.isLoading}
        error={tenants.isError}
        onRetry={() => void tenants.refetch()}
        empty={t('tenants.empty')}
        onRowClick={(r) => {
          void navigate(`/console/tenants/${r.id}`);
        }}
        searchable
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
    </div>
  );
}
