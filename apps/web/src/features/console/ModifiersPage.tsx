import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../components/console/PageHeader';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { ModifierView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

const OPS = ['override_rate', 'percent_off', 'flat_off', 'percent_add'];

export function ModifiersPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'modifiers'], queryFn: () => api.listModifiers() });

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('global');
  const [op, setOp] = useState('percent_off');
  const [value, setValue] = useState('');
  const [whenExpr, setWhenExpr] = useState('');
  const [priority, setPriority] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createModifier({
        scope,
        op,
        value: value.trim() === '' ? undefined : Number(value),
        whenExpr: whenExpr.trim() === '' ? undefined : whenExpr.trim(),
        priority: priority.trim() === '' ? undefined : Number(priority),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'modifiers'] });
      toast(t('modifiers.created'));
      setOpen(false);
    },
    onError: (e) => toast(e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'), 'error'),
  });

  const columns: Column<ModifierView>[] = [
    { key: 'scope', header: t('modifiers.cols.scope'), width: '1fr', cell: (r) => r.scope },
    { key: 'op', header: t('modifiers.cols.op'), width: '160px', cell: (r) => r.op },
    { key: 'value', header: t('modifiers.cols.value'), width: '100px', cell: (r) => r.value ?? '—' },
    { key: 'priority', header: t('modifiers.cols.priority'), width: '100px', cell: (r) => String(r.priority) },
    { key: 'active', header: t('modifiers.cols.active'), width: '110px', cell: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', height: '100%' }}>
      <PageHeader
        title={t('modifiers.title')}
        count={data?.length}
        action={
          <Button variant="ghost" onClick={() => setOpen(true)}>
            <PlusIcon size={14} weight="bold" /> {t('modifiers.new')}
          </Button>
        }
      />
      <DataTable columns={columns} rows={data ?? []} rowKey={(r) => r.id} loading={isLoading} empty={t('modifiers.empty')} fill />
      <Modal open={open} title={t('modifiers.new')} onClose={() => setOpen(false)}
        footer={<Button variant="cta" onClick={() => create.mutate()}>{t('modifiers.submit')}</Button>}>
        <TextField label={t('modifiers.form.scope')} value={scope} onChange={(e) => setScope(e.target.value)} />
        <SelectField label={t('modifiers.form.op')} value={op} onChange={(v) => setOp(v)}
          options={OPS.map((o) => ({ value: o, label: o }))} />
        <TextField label={t('modifiers.form.value')} value={value} onChange={(e) => setValue(e.target.value)} />
        <TextField label={t('modifiers.form.whenExpr')} value={whenExpr} onChange={(e) => setWhenExpr(e.target.value)} />
        <TextField label={t('modifiers.form.priority')} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </Modal>
    </div>
  );
}
