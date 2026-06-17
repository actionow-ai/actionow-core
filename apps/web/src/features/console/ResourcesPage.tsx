import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { useSetConsoleAction, useSetConsoleBack } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { StatusBadge } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import { qk } from '../../lib/api/queryKeys';
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
  const [rid, setRid] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [kind, setKind] = useState<'model' | 'workflow'>('model');
  const [modality, setModality] = useState('text');
  const [provider, setProvider] = useState('openai');
  const [execModes, setExecModes] = useState('blocking');
  const [ioSchema, setIoSchema] = useState('{\n  "inputs": [],\n  "outputs": []\n}');
  const [jsonErr, setJsonErr] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: () => {
      const parsed = validateJson(ioSchema);
      if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
      return api.createResource({
        id: rid,
        tenantId,
        kind,
        modality,
        providerType: provider,
        execModes: execModes.split(',').map((s) => s.trim()).filter(Boolean),
        ioSchema: parsed.value,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.resources() });
      toast(t('resources.created'));
      setOpen(false);
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'), 'error'),
  });

  const action = useMemo(
    () => (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('resources.new')}
      </Button>
    ),
    [t],
  );
  useSetConsoleAction(action);
  // On a narrow viewport the detail replaces the list, so offer a back target.
  useSetConsoleBack(id !== undefined && !isWide ? { to: '/console/resources', label: t('resources.detail.back') } : null);

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
          badge={<StatusBadge status={r.status} />}
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
      <div className="panel" style={{ height: '100%', display: 'grid', placeItems: 'center', borderRadius: 'var(--r-md)', color: 'var(--muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-6)' }}>
        {t('resources.detail.pick')}
      </div>
    );

  const modal = (
    <Modal
      open={open}
      title={t('resources.new')}
      onClose={() => setOpen(false)}
      footer={
        <Button variant="cta" onClick={() => create.mutate()}>
          {t('resources.submit')}
        </Button>
      }
    >
      <TextField label={t('resources.form.id')} value={rid} onChange={(e) => setRid(e.target.value)} />
      <TextField label={t('resources.form.tenant')} value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
      <SelectField
        label={t('resources.form.kind')}
        value={kind}
        onChange={(v) => setKind(v as 'model' | 'workflow')}
        options={[
          { value: 'model', label: t('resources.kind.model') },
          { value: 'workflow', label: t('resources.kind.workflow') },
        ]}
      />
      <TextField label={t('resources.form.modality')} value={modality} onChange={(e) => setModality(e.target.value)} />
      <TextField label={t('resources.form.provider')} value={provider} onChange={(e) => setProvider(e.target.value)} />
      <TextField label={t('resources.form.execModes')} value={execModes} onChange={(e) => setExecModes(e.target.value)} />
      <JsonField
        label={t('resources.form.ioSchema')}
        value={ioSchema}
        onChange={(v) => {
          setIoSchema(v);
          setJsonErr(validateJson(v).ok ? undefined : 'invalid JSON');
        }}
        error={jsonErr}
      />
    </Modal>
  );

  // Wide: master list + detail side by side. Narrow: detail replaces list when selected.
  if (isWide) {
    return (
      <div style={{ height: '100%', display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(360px, 1.2fr)', gap: 'var(--s-3)' }}>
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
