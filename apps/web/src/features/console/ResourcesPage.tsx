import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

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
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import {
  COMMON_PROVIDERS,
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
import { ResourceDetailPane } from './ResourceDetailPane';

export function ResourcesPage() {
  const { t } = useTranslation('console');
  const { id } = useParams();
  const navigate = useNavigate();
  const api = useAdminApi();
  const qc = useQueryClient();
  const isWide = useMediaQuery(BP.xl);
  const { data, isLoading } = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
  });

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
  // On a narrow viewport the detail replaces the list, so offer a back target.
  useSetConsoleBack(
    id !== undefined && !isWide
      ? { to: '/console/resources', label: t('resources.detail.back') }
      : null,
  );

  const list = (
    <CardCollection
      rows={data ?? []}
      loading={isLoading}
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
          chips={[r.modality, r.provider_type, ...r.exec_modes]}
          onClick={() => void navigate(`/console/resources/${r.id}`)}
          selected={r.id === id}
        />
      )}
    />
  );

  const detail =
    id !== undefined ? (
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
      <TextField
        label={t('resources.form.provider')}
        tooltip={t('resources.tip.providerType')}
        hint={COMMON_PROVIDERS.join(' · ')}
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
          gridTemplateColumns: 'minmax(300px, 1fr) minmax(360px, 1.2fr)',
          gap: 'var(--s-3)',
        }}
      >
        <div style={{ minHeight: 0, overflowY: 'auto', padding: 'var(--s-2)' }}>{list}</div>
        <div style={{ minHeight: 0, overflowY: 'auto', padding: 'var(--s-2)' }}>{detail}</div>
        {modal}
      </div>
    );
  }

  return (
    <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 'var(--s-2)' }}>
      {id !== undefined ? detail : list}
      {modal}
    </div>
  );
}
