import { PlusIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { Money } from '../../components/data/Money';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import type { AccountView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function AccountsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const [createOpen, setCreateOpen] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [credits, setCredits] = useState(0);
  const [account, setAccount] = useState<AccountView | null>(null);

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCredits, setTopupCredits] = useState(0);

  const create = useMutation({
    mutationFn: () => api.createAccount({ tenantId, credits: credits > 0 ? credits : undefined }),
    onSuccess: (acc) => {
      setAccount(acc);
      toast(t('accounts.created'));
      setCreateOpen(false);
      setCredits(0);
    },
    onError: mutationError(t),
  });

  const topup = useMutation({
    mutationFn: () => api.topup(account?.id ?? '', { credits: topupCredits }),
    onSuccess: (r) => {
      setAccount((a) => (a ? { ...a, credit_balance: r.balance } : a));
      toast(t('accounts.topup.done'));
      setTopupOpen(false);
      setTopupCredits(0);
    },
    onError: mutationError(t),
  });

  const action = useMemo(
    () => (
      <Button variant="ghost" onClick={() => setCreateOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('accounts.new')}
      </Button>
    ),
    [t],
  );
  useSetConsoleAction(action);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      {account ? (
        <div
          className="glass"
          style={{ padding: 'var(--s-5)', borderRadius: 'var(--r-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <div style={{ fontSize: 'var(--fs-nano)', textTransform: 'uppercase', color: 'var(--muted)' }}>{t('accounts.cols.balance')}</div>
            <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, marginTop: 6 }}>
              <Money micro={account.credit_balance} />
            </div>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)', marginTop: 4 }}>{account.id}</div>
          </div>
          <Button variant="ghost" onClick={() => setTopupOpen(true)}>
            {t('accounts.topup.action')}
          </Button>
        </div>
      ) : (
        <div
          className="panel"
          style={{ padding: 'var(--s-6)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-sm)', borderRadius: 'var(--r-md)' }}
        >
          {t('accounts.empty')}
        </div>
      )}

      <Modal
        open={createOpen}
        title={t('accounts.new')}
        onClose={() => setCreateOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()} loading={create.isPending}>
            {t('accounts.submit')}
          </Button>
        }
      >
        <TenantSelect label={t('accounts.form.tenant')} value={tenantId} onChange={setTenantId} placeholder="—" />
        <NumberField label={t('accounts.form.credits')} value={credits} onChange={setCredits} min={0} />
      </Modal>

      <Modal
        open={topupOpen}
        title={t('accounts.topup.title')}
        onClose={() => setTopupOpen(false)}
        footer={
          <Button variant="cta" onClick={() => topup.mutate()} loading={topup.isPending}>
            {t('accounts.topup.submit')}
          </Button>
        }
      >
        <NumberField label={t('accounts.topup.credits')} value={topupCredits} onChange={setTopupCredits} min={0} />
      </Modal>
    </div>
  );
}
