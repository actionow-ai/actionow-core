import { PlusIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { Money } from '../../components/data/Money';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { AccountView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function AccountsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const [createOpen, setCreateOpen] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [credits, setCredits] = useState('');
  const [account, setAccount] = useState<AccountView | null>(null);

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCredits, setTopupCredits] = useState('');

  const create = useMutation({
    mutationFn: () => api.createAccount({ tenantId, credits: credits ? Number(credits) : undefined }),
    onSuccess: (acc) => {
      setAccount(acc);
      toast(t('accounts.created'));
      setCreateOpen(false);
      setCredits('');
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`) : t('errors.network'), 'error'),
  });

  const topup = useMutation({
    mutationFn: () => api.topup(account?.id ?? '', { credits: Number(topupCredits) }),
    onSuccess: (r) => {
      setAccount((a) => (a ? { ...a, credit_balance: r.balance } : a));
      toast(t('accounts.topup.done'));
      setTopupOpen(false);
      setTopupCredits('');
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`) : t('errors.network'), 'error'),
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
          <Button variant="cta" onClick={() => create.mutate()}>
            {t('accounts.submit')}
          </Button>
        }
      >
        <TenantSelect label={t('accounts.form.tenant')} value={tenantId} onChange={setTenantId} placeholder="—" />
        <TextField
          label={t('accounts.form.credits')}
          type="number"
          min="0"
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
        />
      </Modal>

      <Modal
        open={topupOpen}
        title={t('accounts.topup.title')}
        onClose={() => setTopupOpen(false)}
        footer={
          <Button variant="cta" onClick={() => topup.mutate()}>
            {t('accounts.topup.submit')}
          </Button>
        }
      >
        <TextField
          label={t('accounts.topup.credits')}
          type="number"
          min="0"
          value={topupCredits}
          onChange={(e) => setTopupCredits(e.target.value)}
        />
      </Modal>
    </div>
  );
}
