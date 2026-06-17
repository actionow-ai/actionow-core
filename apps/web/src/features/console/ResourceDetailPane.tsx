import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelView, PricebookMethod, PricebookTiming, PricebookView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

/** The right pane of the Resources master-detail: a resource's channels + pricebook. */
export function ResourceDetailPane({ id }: { id: string }) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const resources = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
  });
  const resource = (resources.data ?? []).find((r) => r.id === id);
  const channels = useQuery({ queryKey: qk.channels(id), queryFn: () => api.listChannels(id), enabled: id !== '' });
  const pricebook = useQuery({ queryKey: qk.pricebook(id), queryFn: () => api.listPricebook(id), enabled: id !== '' });

  const [chOpen, setChOpen] = useState(false);
  const [chProvider, setChProvider] = useState('openai');
  const [chCred, setChCred] = useState('');
  const [chWeight, setChWeight] = useState('1');
  const addChannel = useMutation({
    mutationFn: () =>
      api.createChannel(id, {
        providerType: chProvider,
        credentialRef: chCred.trim() === '' ? undefined : chCred.trim(),
        weight: Number(chWeight) || 1,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
      toast(t('resources.detail.channelAdded'));
      setChOpen(false);
    },
    onError: mutationError(t),
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
        resourceId: id,
        resourceVersion: resource?.current_version ?? 1,
        version: 1,
        method: method as PricebookMethod,
        timing: timing as PricebookTiming,
        spec: parsed.value,
        active: true,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.pricebook(id) });
      toast(t('resources.detail.priceAdded'));
      setPbOpen(false);
    },
    onError: mutationError(t),
  });

  const chCols: Column<ChannelView>[] = [
    { key: 'provider', header: t('channels.cols.provider'), cell: (r) => r.provider_type },
    { key: 'endpoint', header: t('channels.cols.endpoint'), cell: (r) => r.endpoint ?? '—' },
    { key: 'model', header: t('channels.cols.model'), cell: (r) => r.model ?? '—' },
    { key: 'weight', header: t('channels.cols.weight'), cell: (r) => String(r.weight), width: '64px' },
    { key: 'status', header: t('channels.cols.status'), cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />, width: '96px' },
  ];

  const pbCols: Column<PricebookView>[] = [
    { key: 'method', header: t('pricebook.cols.method'), cell: (r) => r.method },
    { key: 'timing', header: t('pricebook.cols.timing'), cell: (r) => r.timing },
    { key: 'version', header: t('pricebook.cols.version'), cell: (r) => String(r.version) },
    {
      key: 'active',
      header: t('pricebook.cols.active'),
      cell: (r) => {
        const s = r.active ? 'active' : 'inactive';
        return <StatusBadge tone={statusTone(s)} label={t('status.' + s, s)} />;
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)', display: 'flex', alignItems: 'flex-start', gap: 'var(--s-3)' }}>
        {resource && <ProviderIcon provider={resource.provider_type} size={28} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</div>
          {resource && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span>
                {resource.modality} · {resource.provider_type} · {resource.exec_modes.join(', ')}
              </span>
              <StatusBadge tone={statusTone(resource.status)} label={t('status.' + resource.status, resource.status)} />
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader
          title={t('resources.detail.channels')}
          action={
            <Button onClick={() => setChOpen(true)}>
              <PlusIcon size={14} weight="bold" /> {t('resources.detail.addChannel')}
            </Button>
          }
        />
        <DataTable columns={chCols} rows={channels.data ?? []} rowKey={(r) => r.id} loading={channels.isLoading} empty={t('channels.empty')} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader
          title={t('resources.detail.pricebook')}
          action={
            <Button onClick={() => setPbOpen(true)}>
              <PlusIcon size={14} weight="bold" /> {t('resources.detail.addPrice')}
            </Button>
          }
        />
        <DataTable
          columns={pbCols}
          rows={pricebook.data ?? []}
          rowKey={(r) => r.id}
          loading={pricebook.isLoading}
          empty={t('pricebook.empty')}
          searchable
          pageSize={10}
        />
      </div>

      <Modal
        open={chOpen}
        title={t('resources.detail.addChannel')}
        onClose={() => setChOpen(false)}
        footer={
          <Button variant="cta" onClick={() => addChannel.mutate()} loading={addChannel.isPending}>
            {t('resources.detail.addChannel')}
          </Button>
        }
      >
        <TextField label={t('channels.form.provider')} value={chProvider} onChange={setChProvider} />
        <TextField label={t('channels.form.credentialRef')} value={chCred} onChange={setChCred} />
        <TextField label={t('channels.form.weight')} value={chWeight} onChange={setChWeight} />
      </Modal>

      <Modal
        open={pbOpen}
        title={t('resources.detail.addPrice')}
        onClose={() => setPbOpen(false)}
        footer={
          <Button variant="cta" onClick={() => addPrice.mutate()} loading={addPrice.isPending}>
            {t('resources.detail.addPrice')}
          </Button>
        }
      >
        <TextField label={t('pricebook.form.method')} value={method} onChange={setMethod} />
        <TextField label={t('pricebook.form.timing')} value={timing} onChange={setTiming} />
        <JsonField
          label={t('pricebook.form.spec')}
          value={spec}
          onChange={(v) => {
            setSpec(v);
            setPbErr(validateJson(v).ok ? undefined : 'invalid JSON');
          }}
          error={pbErr}
        />
      </Modal>
    </div>
  );
}
