import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { PageHeader } from '../../components/console/PageHeader';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { ResourceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ResourcesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'resources'], queryFn: () => api.listResources() });

  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
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
        id,
        tenantId,
        kind,
        modality,
        providerType: provider,
        execModes: execModes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        ioSchema: parsed.value,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'resources'] });
      toast(t('resources.created'));
      setOpen(false);
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'), 'error'),
  });

  const columns: Column<ResourceView>[] = [
    {
      key: 'id',
      header: t('resources.cols.id'),
      width: 'minmax(160px, 1.4fr)',
      cell: (r) => (
        <Link to={`/console/resources/${r.id}`} style={{ color: 'var(--accent)' }}>
          {r.id}
        </Link>
      ),
    },
    { key: 'modality', header: t('resources.cols.modality'), width: '120px', cell: (r) => r.modality },
    { key: 'provider', header: t('resources.cols.provider'), width: '140px', cell: (r) => r.provider_type },
    { key: 'execModes', header: t('resources.cols.execModes'), width: '1fr', cell: (r) => r.exec_modes.join(', ') },
    { key: 'status', header: t('resources.cols.status'), width: '110px', cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', height: '100%' }}>
      <PageHeader
        title={t('resources.title')}
        count={data?.length}
        action={
          <Button variant="ghost" onClick={() => setOpen(true)}>
            <PlusIcon size={14} weight="bold" /> {t('resources.new')}
          </Button>
        }
      />
      <DataTable columns={columns} rows={data ?? []} rowKey={(r) => r.id} loading={isLoading} empty={t('resources.empty')} fill />

      <Modal
        open={open}
        title={t('resources.new')}
        onClose={() => setOpen(false)}
        footer={<Button variant="cta" onClick={() => create.mutate()}>{t('resources.submit')}</Button>}
      >
        <TextField label={t('resources.form.id')} value={id} onChange={(e) => setId(e.target.value)} />
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
    </div>
  );
}
