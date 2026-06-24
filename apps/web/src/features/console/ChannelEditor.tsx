import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconPicker } from '../../components/data/IconPicker';
import { SecretSelect } from '../../components/data/SecretSelect';
import { Button } from '../../components/ui/Button';
import { ComboboxField } from '../../components/ui/ComboboxField';
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
import { STALE_REFERENCE } from '../../lib/query';

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
  presetPluginId,
  open,
  onClose,
}: {
  /** Fixed platform (resource) — omit to let the operator pick one (模型接入 3-pane). */
  resourceId?: string;
  channel?: ChannelView;
  /** Default plugin binding (the 3-pane's selected plugin). */
  presetPluginId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = channel !== undefined;
  // The platform a channel lives under: fixed by the caller, or picked here when
  // creating from the 3-pane (where the platform is otherwise hidden).
  const [pickedResourceId, setPickedResourceId] = useState(
    channel?.resource_id ?? resourceId ?? '',
  );
  const effectiveResourceId = resourceId ?? channel?.resource_id ?? pickedResourceId;
  const needResourcePick = resourceId === undefined && !editing;
  const resources = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
    enabled: open && needResourcePick,
  });
  // Provider-plugin binding (模型接入 grouping). Defaults to the 3-pane's selected
  // plugin on create; seeded from the channel on edit.
  const [pluginId, setPluginId] = useState(channel?.plugin_id ?? presetPluginId ?? '');
  const plugins = useQuery({
    queryKey: qk.plugins(),
    queryFn: () => api.listPlugins(),
    staleTime: STALE_REFERENCE,
    enabled: open,
  });
  const pluginOptions = [
    { value: '', label: t('channels.form.pluginNone') },
    ...(plugins.data ?? []).map((p) => ({ value: p.id, label: p.label })),
  ];

  // Model suggestions = this resource's already-registered model names (free
  // entry still allowed, so an upstream-only model can be typed).
  const models = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });
  const modelOptions = (models.data ?? [])
    .filter((m) => m.resource_id === effectiveResourceId)
    .map((m) => m.name);

  // Fault-tolerance policies bindable to this channel (调用容错). '' = unbound.
  const faultPolicies = useQuery({
    queryKey: qk.faultPolicies(),
    queryFn: () => api.listFaultPolicies(),
    staleTime: STALE_REFERENCE,
  });
  const faultPolicyOptions = [
    { value: '', label: t('channels.form.faultPolicyNone') },
    ...(faultPolicies.data ?? []).map((p) => ({ value: p.id, label: p.name })),
  ];

  // Managed egress proxies (代理) — picking one sets proxyRef to its id; a raw
  // env/locator can still be typed in the advanced field below.
  const proxies = useQuery({
    queryKey: qk.proxies(),
    queryFn: () => api.listProxies(),
    staleTime: STALE_REFERENCE,
  });
  const proxyOptions = [
    { value: '', label: t('channels.form.proxyNone') },
    ...(proxies.data ?? []).map((p) => ({ value: p.id, label: `${p.name} · ${p.scheme} ${p.host}` })),
  ];

  const [providerType, setProviderType] = useState(channel?.provider_type ?? '');
  const [faultPolicyId, setFaultPolicyId] = useState(channel?.fault_policy_id ?? '');
  const [endpoint, setEndpoint] = useState(channel?.endpoint ?? '');
  const [model, setModel] = useState(channel?.model ?? '');
  const [proxyRef, setProxyRef] = useState(channel?.proxy_ref ?? '');
  const [credentialRef, setCredentialRef] = useState(channel?.credential_ref ?? '');
  const [weight, setWeight] = useState(channel?.weight ?? 1);
  // Operator cost = what *we* pay upstream per 1M tokens, stored as a µUSD
  // string; the form edits human USD (÷1e6 to seed, the server re-multiplies).
  // `null`/absent → blank (0), so an untouched create sends no cost.
  const usd = (micro: string | null | undefined) => (micro ? Number(micro) / 1_000_000 : 0);
  const [inputCostUsd, setInputCostUsd] = useState(usd(channel?.input_cost_per_1m));
  const [outputCostUsd, setOutputCostUsd] = useState(usd(channel?.output_cost_per_1m));
  const [status, setStatus] = useState<ChannelStatus>(
    (channel?.status as ChannelStatus | undefined) ?? 'active',
  );
  const [configRows, setConfigRows] = useState<KvRow[]>(rowsFromObject(channel?.config));
  // Selectable brand icon (icon_asset.key); null → derived from plugin/provider.
  const [icon, setIcon] = useState<string | null>(channel?.icon ?? null);
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
    onSuccess: async (s) => {
      // Refresh the SecretSelect list so the just-created secret is selectable,
      // then point credentialRef at it.
      await qc.invalidateQueries({ queryKey: qk.secrets() });
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
      // Cost diverges by verb: a PATCH sends `null` to clear a previously-set
      // cost, but a create omits it entirely (the schema rejects `null`).
      return editing
        ? api.updateChannel(effectiveResourceId, channel.id, {
            ...base,
            inputCostUsdPer1m: inputCostUsd > 0 ? inputCostUsd : null,
            outputCostUsdPer1m: outputCostUsd > 0 ? outputCostUsd : null,
            // null unbinds a previously-set policy → engine defaults.
            faultPolicyId: faultPolicyId === '' ? null : faultPolicyId,
            // null clears a previously-set icon → derived from plugin/provider.
            icon,
            // null unbinds the plugin grouping.
            pluginId: pluginId === '' ? null : pluginId,
          })
        : api.createChannel(
            effectiveResourceId,
            {
              ...base,
              providerType,
              inputCostUsdPer1m: inputCostUsd > 0 ? inputCostUsd : undefined,
              outputCostUsdPer1m: outputCostUsd > 0 ? outputCostUsd : undefined,
              ...(faultPolicyId === '' ? {} : { faultPolicyId }),
              ...(icon !== null ? { icon } : {}),
              ...(pluginId === '' ? {} : { pluginId }),
            },
            idemKey,
          );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(effectiveResourceId) });
      if (pluginId !== '') await qc.invalidateQueries({ queryKey: qk.pluginChannels(pluginId) });
      if (presetPluginId !== undefined && presetPluginId !== pluginId)
        await qc.invalidateQueries({ queryKey: qk.pluginChannels(presetPluginId) });
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
        <Button
          variant="cta"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={needResourcePick && effectiveResourceId === ''}
        >
          {t('channels.save')}
        </Button>
      }
    >
      {needResourcePick && (
        <SelectField
          label={t('channels.form.platform')}
          tooltip={t('channels.tip.platform')}
          value={pickedResourceId}
          onChange={setPickedResourceId}
          options={(resources.data ?? []).map((r) => ({ value: r.id, label: r.id }))}
          placeholder={t('channels.form.platformPlaceholder')}
        />
      )}
      <SelectField
        label={t('channels.form.plugin')}
        tooltip={t('channels.tip.plugin')}
        value={pluginId}
        onChange={setPluginId}
        options={pluginOptions}
      />
      <ComboboxField
        label={t('channels.form.provider')}
        tooltip={t('channels.tip.provider')}
        hint={editing ? t('channels.tip.providerFixed') : COMMON_PROVIDERS.join(' · ')}
        options={[...COMMON_PROVIDERS]}
        value={providerType}
        onChange={setProviderType}
        disabled={editing}
      />
      <IconPicker
        label={t('channels.form.icon')}
        hint={t('channels.tip.icon')}
        value={icon}
        onChange={setIcon}
        fallbacks={[providerType]}
      />
      <TextField
        label={t('channels.form.endpoint')}
        tooltip={t('channels.tip.endpoint')}
        value={endpoint}
        onChange={setEndpoint}
      />
      <ComboboxField
        label={t('channels.form.model')}
        tooltip={t('channels.tip.model')}
        options={modelOptions}
        value={model}
        onChange={setModel}
      />
      <SelectField
        label={t('channels.form.proxy')}
        tooltip={t('channels.tip.proxy')}
        value={(proxies.data ?? []).some((p) => p.id === proxyRef) ? proxyRef : ''}
        onChange={setProxyRef}
        options={proxyOptions}
      />
      <TextField
        label={t('channels.form.proxyRef')}
        tooltip={t('channels.tip.proxyRef')}
        hint={t('channels.tip.proxyRefAdvanced')}
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
        <NumberField
          label={t('channels.form.inputCost')}
          tooltip={t('channels.tip.cost')}
          hint={t('channels.tip.costUnit')}
          value={inputCostUsd}
          onChange={setInputCostUsd}
          min={0}
          step={0.01}
        />
        <NumberField
          label={t('channels.form.outputCost')}
          value={outputCostUsd}
          onChange={setOutputCostUsd}
          min={0}
          step={0.01}
        />
      </div>
      <SelectField
        label={t('channels.form.status')}
        tooltip={t('channels.tip.status')}
        value={status}
        onChange={(v) => setStatus(v as ChannelStatus)}
        options={toOptions(CHANNEL_STATUSES, t)}
      />
      <SelectField
        label={t('channels.form.faultPolicy')}
        tooltip={t('channels.tip.faultPolicy')}
        value={faultPolicyId}
        onChange={setFaultPolicyId}
        options={faultPolicyOptions}
      />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SecretSelect
            label={t('channels.form.credentialRef')}
            tooltip={t('channels.tip.credentialRef')}
            placeholder={t('credentials.pickExisting')}
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
