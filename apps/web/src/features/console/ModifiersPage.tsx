import { PlusIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { StatusBadge } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import { useAdminApi } from '../../lib/api/useAdminApi';

const OPS = ['override_rate', 'percent_off', 'flat_off', 'percent_add'];

export function ModifiersPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: qk.modifiers(), queryFn: () => api.listModifiers() });

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
      await qc.invalidateQueries({ queryKey: qk.modifiers() });
      toast(t('modifiers.created'));
      setOpen(false);
    },
    onError: mutationError(t),
  });

  const action = useMemo(
    () => (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('modifiers.new')}
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
        empty={t('modifiers.empty')}
        renderCard={(r) => (
          <EntityCard
            key={r.id}
            icon={SlidersHorizontalIcon}
            title={r.scope}
            badge={<StatusBadge status={r.active ? 'active' : 'inactive'} />}
            chips={[r.op]}
            meta={[
              { label: t('modifiers.cols.value'), value: r.value ?? '—' },
              { label: t('modifiers.cols.priority'), value: String(r.priority) },
            ]}
          />
        )}
      />

      <Modal
        open={open}
        title={t('modifiers.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()}>
            {t('modifiers.submit')}
          </Button>
        }
      >
        <TextField label={t('modifiers.form.scope')} value={scope} onChange={(e) => setScope(e.target.value)} />
        <SelectField label={t('modifiers.form.op')} value={op} onChange={(v) => setOp(v)} options={OPS.map((o) => ({ value: o, label: o }))} />
        <TextField label={t('modifiers.form.value')} value={value} onChange={(e) => setValue(e.target.value)} />
        <TextField label={t('modifiers.form.whenExpr')} value={whenExpr} onChange={(e) => setWhenExpr(e.target.value)} />
        <TextField label={t('modifiers.form.priority')} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </Modal>
    </div>
  );
}
