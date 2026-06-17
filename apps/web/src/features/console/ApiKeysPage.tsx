import { KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction, useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { EntityCard } from '../../components/data/EntityCard';
import { StatusBadge } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { TextField } from '../../components/ui/TextField';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { CreateApiKeyBody } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { useUrlState } from '../../lib/useUrlState';

export function ApiKeysPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tenantId, setTenantId] = useUrlState('tenant');
  const { data, isLoading } = useQuery({
    queryKey: qk.apiKeys(tenantId),
    queryFn: () => api.listApiKeys(tenantId),
    enabled: tenantId !== '',
    placeholderData: keepPreviousData,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [allowlist, setAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateApiKeyBody = { tenantId };
      const allow = allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length) body.resourceAllowlist = allow;
      if (rateLimit) body.rateLimit = Number(rateLimit);
      return api.createApiKey(body);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
      setFormOpen(false);
      setAllowlist('');
      setRateLimit('');
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });

  const action = useMemo(
    () => (
      <Button variant="ghost" onClick={() => setFormOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('apiKeys.new')}
      </Button>
    ),
    [t],
  );
  useSetConsoleAction(action);

  const filters = useMemo(
    () => (
      <div style={{ width: 200 }}>
        <TenantSelect value={tenantId} onChange={setTenantId} placeholder={t('apiKeys.form.tenant')} />
      </div>
    ),
    [t, tenantId],
  );
  useSetConsoleFilters(filters);

  return (
    <div style={{ height: '100%' }}>
      <CardCollection
        rows={tenantId === '' ? [] : (data ?? [])}
        loading={tenantId !== '' && isLoading}
        empty={t('apiKeys.empty')}
        renderCard={(r) => (
          <EntityCard
            key={r.id}
            icon={KeyIcon}
            title={<code style={{ fontSize: 'var(--fs-sm)' }}>{r.id}</code>}
            badge={<StatusBadge status={r.status} />}
            chips={[
              ...(r.rate_limit !== null ? [`${String(r.rate_limit)}/min`] : []),
              ...(r.resource_allowlist.length > 0 ? r.resource_allowlist : []),
            ]}
            meta={[{ label: t('apiKeys.cols.created'), value: new Date(r.created_at).toLocaleDateString() }]}
          />
        )}
      />

      <Modal
        open={formOpen}
        title={t('apiKeys.new')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()}>
            {t('apiKeys.submit')}
          </Button>
        }
      >
        <TextField label={t('apiKeys.form.allowlist')} value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />
        <TextField label={t('apiKeys.form.rateLimit')} type="number" min="1" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
      </Modal>

      <Modal
        open={plaintext !== null}
        title={t('apiKeys.reveal.title')}
        onClose={() => setPlaintext(null)}
        footer={
          <Button variant="cta" onClick={() => setPlaintext(null)}>
            {t('apiKeys.reveal.done')}
          </Button>
        }
      >
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--run)' }}>{t('apiKeys.reveal.warn')}</div>
        {plaintext !== null && <CopyField value={plaintext} copyLabel={t('apiKeys.reveal.copy')} copiedLabel={t('apiKeys.reveal.copied')} />}
      </Modal>
    </div>
  );
}
