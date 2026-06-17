import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { KeyValueEditor } from '../../components/ui/KeyValueEditor';
import { type KvRow, objectFromRows, rowsFromObject } from '../../components/ui/kvRows';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { CHANNEL_STATUSES, COMMON_PROVIDERS, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelStatus, ChannelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

const ASYNC_MEDIA_PRESET = {
  submitPath: '/api/v1/tasks',
  pollPath: '/api/v1/tasks/{id}',
  signatureHeader: 'X-Signature',
  timestampHeader: 'X-Timestamp',
};

/**
 * Channel create/edit `Drawer`. The parent owns the editable `KvRow[]` config
 * (seeded from the channel via `rowsFromObject`, collapsed via `objectFromRows`
 * at submit) — no raw JSON. New → `createChannel`; edit → `updateChannel`
 * (PATCH). An inline "new credential" panel creates an encrypted secret and
 * backfills its id into `credentialRef`. Open with `key={channel?.id ?? 'new'}`
 * so the seeded state reseeds per row.
 */
export function ChannelEditor({
  resourceId,
  channel,
  open,
  onClose,
}: {
  resourceId: string;
  channel?: ChannelView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = channel !== undefined;

  const [providerType, setProviderType] = useState(channel?.provider_type ?? '');
  const [endpoint, setEndpoint] = useState(channel?.endpoint ?? '');
  const [model, setModel] = useState(channel?.model ?? '');
  const [proxyRef, setProxyRef] = useState(channel?.proxy_ref ?? '');
  const [credentialRef, setCredentialRef] = useState(channel?.credential_ref ?? '');
  const [weight, setWeight] = useState(channel?.weight ?? 1);
  const [status, setStatus] = useState<ChannelStatus>(
    (channel?.status as ChannelStatus | undefined) ?? 'active',
  );
  const [configRows, setConfigRows] = useState<KvRow[]>(rowsFromObject(channel?.config));
  // A stable idempotency key for this editor instance (remounted per open via
  // `key`), so an accidental double-submit of a create replays instead of dupes.
  const [idemKey] = useState(() => crypto.randomUUID());

  const [credOpen, setCredOpen] = useState(false);
  const [credValue, setCredValue] = useState('');
  const [credLabel, setCredLabel] = useState('');
  const createCred = useMutation({
    mutationFn: () =>
      api.createSecret({
        value: credValue,
        label: credLabel.trim() === '' ? undefined : credLabel.trim(),
      }),
    onSuccess: (s) => {
      setCredentialRef(s.id);
      setCredOpen(false);
      setCredValue('');
      setCredLabel('');
      toast(t('credentials.created'));
    },
    onError: mutationError(t),
  });

  const save = useMutation({
    mutationFn: () => {
      const cfg = objectFromRows(configRows);
      // `providerType` is immutable after creation (the backend strips it from a
      // PATCH), so it lives only on the create branch — never in the shared body.
      const base = {
        endpoint: endpoint.trim() === '' ? undefined : endpoint.trim(),
        model: model.trim() === '' ? undefined : model.trim(),
        proxyRef: proxyRef.trim() === '' ? undefined : proxyRef.trim(),
        credentialRef: credentialRef.trim() === '' ? undefined : credentialRef.trim(),
        weight,
        status,
        config: Object.keys(cfg).length > 0 ? cfg : undefined,
      };
      return editing
        ? api.updateChannel(resourceId, channel.id, base)
        : api.createChannel(resourceId, { ...base, providerType }, idemKey);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(resourceId) });
      toast(t(editing ? 'channels.updated' : 'channels.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  return (
    <Drawer
      open={open}
      title={t(editing ? 'channels.editTitle' : 'channels.addTitle')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
          {t('channels.save')}
        </Button>
      }
    >
      <TextField
        label={t('channels.form.provider')}
        tooltip={t('channels.tip.provider')}
        hint={editing ? t('channels.tip.providerFixed') : COMMON_PROVIDERS.join(' · ')}
        value={providerType}
        onChange={setProviderType}
        disabled={editing}
      />
      <TextField
        label={t('channels.form.endpoint')}
        tooltip={t('channels.tip.endpoint')}
        value={endpoint}
        onChange={setEndpoint}
      />
      <TextField
        label={t('channels.form.model')}
        tooltip={t('channels.tip.model')}
        value={model}
        onChange={setModel}
      />
      <TextField
        label={t('channels.form.proxyRef')}
        tooltip={t('channels.tip.proxyRef')}
        value={proxyRef}
        onChange={setProxyRef}
      />
      <NumberField
        label={t('channels.form.weight')}
        tooltip={t('channels.tip.weight')}
        value={weight}
        onChange={setWeight}
        min={1}
      />
      <SelectField
        label={t('channels.form.status')}
        tooltip={t('channels.tip.status')}
        value={status}
        onChange={(v) => setStatus(v as ChannelStatus)}
        options={toOptions(CHANNEL_STATUSES, t)}
      />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
        <div style={{ flex: 1 }}>
          <TextField
            label={t('channels.form.credentialRef')}
            tooltip={t('channels.tip.credentialRef')}
            value={credentialRef}
            onChange={setCredentialRef}
          />
        </div>
        <Button variant="ghost" onClick={() => setCredOpen((v) => !v)}>
          {t('credentials.new')}
        </Button>
      </div>
      {credOpen && (
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-sm)',
            padding: 'var(--s-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-2)',
          }}
        >
          <TextField
            label={t('credentials.value')}
            tooltip={t('credentials.tip.value')}
            value={credValue}
            onChange={setCredValue}
            type="password"
          />
          <TextField label={t('credentials.label')} value={credLabel} onChange={setCredLabel} />
          <Button variant="cta" onClick={() => createCred.mutate()} loading={createCred.isPending}>
            {t('credentials.save')}
          </Button>
        </div>
      )}
      <KeyValueEditor
        label={t('channels.form.config')}
        tooltip={t('channels.tip.config')}
        value={configRows}
        onChange={setConfigRows}
        presets={[{ label: t('channels.preset.asyncMedia'), value: ASYNC_MEDIA_PRESET }]}
      />
    </Drawer>
  );
}
