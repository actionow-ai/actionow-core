import { BuildingsIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

export function TenantsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState('field');

  const create = useMutation({
    mutationFn: () => api.createTenant({ name, isolationMode: isolation as 'field' | 'schema' | 'db' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.tenants() });
      toast(t('tenants.created'));
      setOpen(false);
      setName('');
    },
    onError: mutationError(t),
  });

  const action = useMemo(
    () => (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('tenants.new')}
      </Button>
    ),
    [t],
  );
  useSetConsoleAction(action);

  return (
    <div style={{ height: '100%' }}>
      <CardCollection
        rows={data ?? []}
        loading={isLoading}
        empty={t('tenants.empty')}
        renderCard={(r) => (
          <EntityCard
            key={r.id}
            icon={BuildingsIcon}
            title={r.name}
            chips={[t(`tenants.isolation.${r.isolation_mode}`, r.isolation_mode)]}
            meta={[{ label: t('tenants.cols.created'), value: new Date(r.created_at).toLocaleDateString() }]}
          />
        )}
      />

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
