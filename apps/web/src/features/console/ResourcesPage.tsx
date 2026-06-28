import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction, useSetConsoleBack } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { IoSchemaField } from '../../components/data/IoSchemaField';
import { buildIoSchema, emptyIoField, type IoField } from '../../components/data/ioSchemaShape';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { ChipsField } from '../../components/ui/ChipsField';
import { ComboboxField } from '../../components/ui/ComboboxField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import {
  COMMON_PROVIDERS,
  enumLabel,
  EXEC_MODES,
  MODALITIES,
  RESOURCE_KINDS,
  toOptions,
} from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { Modality } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { BP } from '../../lib/breakpoints';
import { STALE_REFERENCE } from '../../lib/query';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useUrlState } from '../../lib/useUrlState';
import { ResourceDetailPane } from './ResourceDetailPane';

export function ResourcesPage() {
  const { t } = useTranslation('console');
  // Resource selection lives in url-state (`?id=`) on the /console/catalog route
  // (no route param), so a selection is deep-linkable and back-button friendly.
  const [id, setId] = useUrlState('id');
  const api = useAdminApi();
  const qc = useQueryClient();
  const isWide = useMediaQuery(BP.xxl);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
  });
  // Shared models cache (same key as the detail pane's Models tab) → per-resource
  // model count for the list cards, with no extra per-resource fetch.
  const models = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });
  const modelCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of models.data ?? []) m.set(x.resource_id, (m.get(x.resource_id) ?? 0) + 1);
    return m;
  }, [models.data]);

  const [open, setOpen] = useState(false);
  // A fresh idempotency key per open of the create modal, so a double-submit of
  // one resource replays, but distinct resources never share a key.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const openCreate = () => {
    setIdemKey(crypto.randomUUID());
    setOpen(true);
  };
  const [rid, setRid] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [kind, setKind] = useState<'model' | 'workflow'>('model');
  const [modality, setModality] = useState<Modality>('text');
  const [provider, setProvider] = useState('openai');
  const [execModes, setExecModes] = useState<string[]>(['blocking']);
  const [ioForm, setIoForm] = useState<{ inputs: IoField[]; outputs: IoField[] }>({
    inputs: [{ ...emptyIoField(), key: 'prompt', type: 'string', required: true }],
    outputs: [{ ...emptyIoField(), key: 'text', type: 'string' }],
  });

  const create = useMutation({
    mutationFn: () =>
      api.createResource(
        {
          id: rid,
          tenantId,
          kind,
          modality,
          providerType: provider,
          execModes,
          ioSchema: buildIoSchema(ioForm.inputs, ioForm.outputs),
        },
        idemKey,
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.resources() });
      toast(t('resources.created'));
      setOpen(false);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={openCreate}>
        <PlusIcon size={14} weight="bold" /> {t('resources.new')}
      </Button>
    ),
    [t],
  );
  // On a narrow viewport the detail replaces the list, so offer a back target
  // (clears the selection by dropping `?id`).
  useSetConsoleBack(
    id !== '' && !isWide ? { to: '/console/catalog', label: t('resources.detail.back') } : null,
  );

  const list = (
    <CardCollection
      rows={data ?? []}
      loading={isLoading}
      error={isError}
      onRetry={() => void refetch()}
      empty={t('resources.empty')}
      layout="list"
      renderCard={(r) => (
        <EntityCard
          key={r.id}
          glyph={<ProviderIcon provider={r.provider_type} size={22} />}
          title={r.id}
          badge={
            <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
          }
          chips={[
            enumLabel(t, MODALITIES, r.modality),
            r.provider_type,
            ...r.exec_modes,
            ...((modelCount.get(r.id) ?? 0) > 0
              ? [t('resources.cards.modelsN', { n: modelCount.get(r.id) })]
              : []),
          ]}
          onClick={() => setId(r.id)}
          selected={r.id === id}
        />
      )}
    />
  );

  const detail =
    id !== '' ? (
      <ResourceDetailPane id={id} />
    ) : (
      <div
        className="panel"
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          borderRadius: 'var(--r-md)',
          color: 'var(--muted)',
          fontSize: 'var(--fs-sm)',
          padding: 'var(--s-6)',
        }}
      >
        {t('resources.detail.pick')}
      </div>
    );

  const modal = (
    <Modal
      open={open}
      title={t('resources.new')}
      onClose={() => setOpen(false)}
      footer={
        <Button variant="cta" onClick={() => create.mutate()} loading={create.isPending}>
          {t('resources.submit')}
        </Button>
      }
    >
      <TextField
        label={t('resources.form.id')}
        tooltip={t('resources.tip.id')}
        value={rid}
        onChange={setRid}
      />
      <TenantSelect
        label={t('resources.form.tenant')}
        tooltip={t('resources.tip.tenant')}
        value={tenantId}
        onChange={setTenantId}
      />
      <SelectField
        label={t('resources.form.kind')}
        tooltip={t('resources.tip.kind')}
        value={kind}
        onChange={(v) => setKind(v as 'model' | 'workflow')}
        options={toOptions(RESOURCE_KINDS, t)}
      />
      <SelectField
        label={t('resources.form.modality')}
        tooltip={t('resources.tip.modality')}
        value={modality}
        onChange={(v) => setModality(v as Modality)}
        options={toOptions(MODALITIES, t)}
      />
      <ComboboxField
        label={t('resources.form.provider')}
        tooltip={t('resources.tip.providerType')}
        hint={COMMON_PROVIDERS.join(' · ')}
        options={[...COMMON_PROVIDERS]}
        value={provider}
        onChange={setProvider}
      />
      <ChipsField
        label={t('resources.form.execModes')}
        tooltip={t('resources.tip.execModes')}
        value={execModes}
        onChange={setExecModes}
        suggestions={[...EXEC_MODES]}
      />
      <IoSchemaField value={ioForm} onChange={setIoForm} />
    </Modal>
  );

  // Wide: master list + detail side by side. Narrow: detail replaces list when selected.
  if (isWide) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(420px, 1.4fr)',
          gap: 'var(--s-3)',
        }}
      >
        <div style={SCROLL_COL}>{list}</div>
        <div style={SCROLL_COL}>{detail}</div>
        {modal}
      </div>
    );
  }

  return (
    <div style={SCROLL_COL}>
      {id !== '' ? detail : list}
      {modal}
    </div>
  );
}

// A scroll column in the master-detail. `overflowX: hidden` keeps a card's
// hover-lift shadow from triggering a horizontal scrollbar. No horizontal inset
// — the main content area already has its own gutter (ConsoleLayout), so the
// list/detail read edge-to-edge; a small top/bottom pad keeps the first card's
// hover-lift and the last card's shadow from clipping at the scroll edges.
const SCROLL_COL: CSSProperties = {
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 'var(--s-1) 0 var(--s-4)',
};
