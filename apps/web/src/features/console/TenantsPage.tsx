import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../components/console/PageHeader';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { TenantView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function TenantsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['tenants'], queryFn: () => api.listTenants() });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState('field');

  const create = useMutation({
    mutationFn: () => api.createTenant({ name, isolationMode: isolation as 'field' | 'schema' | 'db' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      toast(t('tenants.created'));
      setOpen(false);
      setName('');
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`) : t('errors.network'), 'error'),
  });

  const columns: Column<TenantView>[] = [
    { key: 'name', header: t('tenants.cols.name'), width: 'minmax(160px, 1.4fr)', cell: (r) => r.name },
    {
      key: 'isolation',
      header: t('tenants.cols.isolation'),
      width: '140px',
      cell: (r) => t(`tenants.isolation.${r.isolation_mode}`, r.isolation_mode),
    },
    { key: 'created', header: t('tenants.cols.created'), width: '180px', cell: (r) => new Date(r.created_at).toLocaleString() },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', height: '100%' }}>
      <PageHeader
        title={t('tenants.title')}
        count={data?.length}
        action={
          <Button variant="ghost" onClick={() => setOpen(true)}>
            <PlusIcon size={14} weight="bold" /> {t('tenants.new')}
          </Button>
        }
      />
      <DataTable columns={columns} rows={data ?? []} rowKey={(r) => r.id} loading={isLoading} empty={t('tenants.empty')} fill />

      <Modal
        open={open}
        title={t('tenants.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()}>
            {t('tenants.submit')}
          </Button>
        }
      >
        <TextField label={t('tenants.form.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField
          label={t('tenants.form.isolation')}
          value={isolation}
          onChange={setIsolation}
          options={[
            { value: 'field', label: t('tenants.isolation.field') },
            { value: 'schema', label: t('tenants.isolation.schema') },
            { value: 'db', label: t('tenants.isolation.db') },
          ]}
        />
      </Modal>
    </div>
  );
}
