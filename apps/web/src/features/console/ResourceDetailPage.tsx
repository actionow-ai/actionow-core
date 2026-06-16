import { ArrowLeftIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { PricebookView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ResourceDetailPage() {
  const { t } = useTranslation('console');
  const { id = '' } = useParams();
  const api = useAdminApi();
  const qc = useQueryClient();

  const resources = useQuery({ queryKey: ['admin', 'resources'], queryFn: () => api.listResources() });
  const resource = (resources.data ?? []).find((r) => r.id === id);
  const pricebook = useQuery({ queryKey: ['admin', 'pricebook', id], queryFn: () => api.listPricebook(id), enabled: id !== '' });

  const [chOpen, setChOpen] = useState(false);
  const [chProvider, setChProvider] = useState('openai');
  const [chCred, setChCred] = useState('');
  const [chWeight, setChWeight] = useState('1');
  const addChannel = useMutation({
    mutationFn: () => api.createChannel(id, {
      providerType: chProvider,
      credentialRef: chCred.trim() === '' ? undefined : chCred.trim(),
      weight: Number(chWeight) || 1,
    }),
    onSuccess: () => { toast(t('resources.detail.channelAdded')); setChOpen(false); },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'), 'error'),
  });

  const [pbOpen, setPbOpen] = useState(false);
  const [method, setMethod] = useState('unit');
  const [timing, setTiming] = useState('post');
  const [spec, setSpec] = useState('{\n  "method": "unit",\n  "dimensions": {}\n}');
  const [pbErr, setPbErr] = useState<string | undefined>(undefined);
  const addPrice = useMutation({
    mutationFn: () => {
      const parsed = validateJson(spec);
      if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
      return api.createPricebook({
        resourceId: id, resourceVersion: resource?.current_version ?? 1, version: 1,
        method, timing, spec: parsed.value, active: true,
      });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['admin', 'pricebook', id] }); toast(t('resources.detail.priceAdded')); setPbOpen(false); },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'), 'error'),
  });

  const pbCols: Column<PricebookView>[] = [
    { key: 'method', header: t('pricebook.cols.method'), cell: (r) => r.method },
    { key: 'timing', header: t('pricebook.cols.timing'), cell: (r) => r.timing },
    { key: 'version', header: t('pricebook.cols.version'), cell: (r) => String(r.version) },
    { key: 'active', header: t('pricebook.cols.active'), cell: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <Link to="/console/resources" style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ArrowLeftIcon size={14} /> {t('resources.detail.back')}
      </Link>
      <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{id}</div>
        {resource && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
            {resource.modality} · {resource.provider_type} · {resource.exec_modes.join(', ')} · <StatusBadge status={resource.status} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('resources.detail.channels')} action={
          <Button onClick={() => setChOpen(true)}><PlusIcon size={14} weight="bold" /> {t('resources.detail.addChannel')}</Button>
        } />
        <div style={{ fontSize: 12, color: 'var(--faint)' }}>{t('channels.note')}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('resources.detail.pricebook')} action={
          <Button onClick={() => setPbOpen(true)}><PlusIcon size={14} weight="bold" /> {t('resources.detail.addPrice')}</Button>
        } />
        <DataTable columns={pbCols} rows={pricebook.data ?? []} rowKey={(r) => r.id} loading={pricebook.isLoading} empty={t('pricebook.empty')} />
      </div>

      <Modal open={chOpen} title={t('resources.detail.addChannel')} onClose={() => setChOpen(false)}
        footer={<Button variant="cta" onClick={() => addChannel.mutate()}>{t('resources.detail.addChannel')}</Button>}>
        <TextField label={t('channels.form.provider')} value={chProvider} onChange={(e) => setChProvider(e.target.value)} />
        <TextField label={t('channels.form.credentialRef')} value={chCred} onChange={(e) => setChCred(e.target.value)} />
        <TextField label={t('channels.form.weight')} value={chWeight} onChange={(e) => setChWeight(e.target.value)} />
      </Modal>

      <Modal open={pbOpen} title={t('resources.detail.addPrice')} onClose={() => setPbOpen(false)}
        footer={<Button variant="cta" onClick={() => addPrice.mutate()}>{t('resources.detail.addPrice')}</Button>}>
        <TextField label={t('pricebook.form.method')} value={method} onChange={(e) => setMethod(e.target.value)} />
        <TextField label={t('pricebook.form.timing')} value={timing} onChange={(e) => setTiming(e.target.value)} />
        <JsonField label={t('pricebook.form.spec')} value={spec}
          onChange={(v) => { setSpec(v); setPbErr(validateJson(v).ok ? undefined : 'invalid JSON'); }} error={pbErr} />
      </Modal>
    </div>
  );
}
