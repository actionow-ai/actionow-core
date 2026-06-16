import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { ApiKeyView, CreateApiKeyBody } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ApiKeysPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tenantId, setTenantId] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => api.listApiKeys(tenantId),
    enabled: tenantId !== '',
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
      await qc.invalidateQueries({ queryKey: ['api-keys', tenantId] });
      setFormOpen(false);
      setAllowlist('');
      setRateLimit('');
      setPlaintext(r.plaintext);
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`) : t('errors.network'), 'error'),
  });

  const columns: Column<ApiKeyView>[] = [
    { key: 'id', header: t('apiKeys.cols.id'), cell: (r) => <code style={{ fontSize: 11 }}>{r.id}</code> },
    { key: 'allow', header: t('apiKeys.cols.allowlist'), cell: (r) => (r.resource_allowlist.length ? r.resource_allowlist.join(', ') : '—') },
    { key: 'rate', header: t('apiKeys.cols.rateLimit'), cell: (r) => r.rate_limit ?? '—' },
    { key: 'status', header: t('apiKeys.cols.status'), cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'created', header: t('apiKeys.cols.created'), cell: (r) => new Date(r.created_at).toLocaleDateString() },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ width: 220 }}>
          <TenantSelect label={t('apiKeys.form.tenant')} value={tenantId} onChange={setTenantId} placeholder="—" />
        </div>
        <Button variant="cta" onClick={() => setFormOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('apiKeys.new')}
        </Button>
      </div>

      <DataTable columns={columns} rows={data ?? []} rowKey={(r) => r.id} loading={isLoading} empty={t('apiKeys.empty')} />

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
        <TextField
          label={t('apiKeys.form.rateLimit')}
          type="number"
          min="1"
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
        />
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
        <div style={{ fontSize: 12, color: 'var(--run)' }}>{t('apiKeys.reveal.warn')}</div>
        {plaintext !== null && (
          <CopyField value={plaintext} copyLabel={t('apiKeys.reveal.copy')} copiedLabel={t('apiKeys.reveal.copied')} />
        )}
      </Modal>
    </div>
  );
}
