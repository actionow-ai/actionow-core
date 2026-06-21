import { PlusIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { enumLabel, MODIFIER_CREDIT_OPS, MODIFIER_OPS, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModifierOp } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/**
 * Render a modifier `value` by its op: credit ops (`flat_off`/`override_rate`)
 * carry a µcredit amount → `<Money>`; percent ops carry a whole-percent int →
 * `%` suffix. Honors the µUSD/Money rule instead of printing a bare number.
 */
function modifierValueDisplay(op: string, value: string | null): ReactNode {
  if (value === null) return '—';
  if (MODIFIER_CREDIT_OPS.has(op as ModifierOp)) return <Money micro={value} />;
  if (op === 'percent_off' || op === 'percent_add') return `${value}%`;
  return value;
}

export function ModifiersPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.modifiers(),
    queryFn: () => api.listModifiers(),
  });

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('global');
  const [op, setOp] = useState<ModifierOp>('percent_off');
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

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('modifiers.new')}
      </Button>
    ),
    [t],
  );

  return (
    <div style={{ height: '100%' }}>
      <CardCollection
        rows={data ?? []}
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        empty={t('modifiers.empty')}
        renderCard={(r) => {
          const s = r.active ? 'active' : 'inactive';
          return (
            <EntityCard
              key={r.id}
              icon={SlidersHorizontalIcon}
              title={r.scope}
              badge={<StatusBadge tone={statusTone(s)} label={t('status.' + s, s)} />}
              chips={[enumLabel(t, MODIFIER_OPS, r.op)]}
              meta={[
                { label: t('modifiers.cols.value'), value: modifierValueDisplay(r.op, r.value) },
                { label: t('modifiers.cols.priority'), value: String(r.priority) },
              ]}
            />
          );
        }}
      />

      <Modal
        open={open}
        title={t('modifiers.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()} loading={create.isPending}>
            {t('modifiers.submit')}
          </Button>
        }
      >
        <TextField label={t('modifiers.form.scope')} value={scope} onChange={setScope} />
        <SelectField label={t('modifiers.form.op')} value={op} onChange={(v) => setOp(v as ModifierOp)} options={toOptions(MODIFIER_OPS, t)} />
        <TextField label={t('modifiers.form.value')} value={value} onChange={setValue} />
        <TextField label={t('modifiers.form.whenExpr')} value={whenExpr} onChange={setWhenExpr} />
        <TextField label={t('modifiers.form.priority')} value={priority} onChange={setPriority} />
      </Modal>
    </div>
  );
}
