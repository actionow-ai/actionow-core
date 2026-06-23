import { PencilSimpleIcon, PlusIcon, SlidersHorizontalIcon, TrashIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { EntityCard } from '../../components/data/EntityCard';
import { LoadMore } from '../../components/data/LoadMore';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { Toggle } from '../../components/ui/Toggle';
import { enumLabel, MODIFIER_CREDIT_OPS, MODIFIER_OPS, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModifierOp, ModifierView } from '../../lib/api/types';
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

/**
 * Prefill a form `value` from a stored modifier. Credit ops persist a µcredit
 * amount, but the form (like create) takes HUMAN credits → divide by 1e6; percent
 * ops persist a whole-percent int used as-is.
 */
function valueForForm(op: string, value: string | null): string {
  if (value === null) return '';
  if (MODIFIER_CREDIT_OPS.has(op as ModifierOp)) return String(Number(value) / 1e6);
  return value;
}

export function ModifiersPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: qk.modifiers(),
    queryFn: ({ pageParam }) => api.listModifiers({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];

  const [open, setOpen] = useState(false);
  // null = create mode; a string id = editing that modifier.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scope, setScope] = useState('global');
  const [op, setOp] = useState<ModifierOp>('percent_off');
  const [value, setValue] = useState('');
  const [whenExpr, setWhenExpr] = useState('');
  const [priority, setPriority] = useState('');
  const [active, setActive] = useState(true);
  const [deleting, setDeleting] = useState<ModifierView | null>(null);

  const openCreate = () => {
    setEditingId(null);
    setScope('global');
    setOp('percent_off');
    setValue('');
    setWhenExpr('');
    setPriority('');
    setActive(true);
    setOpen(true);
  };
  const openEdit = (r: ModifierView) => {
    setEditingId(r.id);
    setScope(r.scope);
    setOp(r.op as ModifierOp);
    setValue(valueForForm(r.op, r.value));
    setWhenExpr(r.when_expr ?? '');
    setPriority(String(r.priority));
    setActive(r.active);
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const num = value.trim() === '' ? undefined : Number(value);
      const pri = priority.trim() === '' ? undefined : Number(priority);
      if (editingId !== null) {
        // `scope` is not patchable; `whenExpr` may be cleared with null.
        return api.updateModifier(editingId, {
          op,
          value: num,
          whenExpr: whenExpr.trim() === '' ? null : whenExpr.trim(),
          priority: pri,
          active,
        });
      }
      // Every op needs a value; reject an empty one before the request (a
      // value-less modifier would break pricing at settle).
      if (num === undefined) throw new Error(t('modifiers.valueRequired'));
      return api.createModifier({
        scope,
        op,
        value: num,
        whenExpr: whenExpr.trim() === '' ? undefined : whenExpr.trim(),
        priority: pri,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.modifiers() });
      toast(editingId !== null ? t('modifiers.updated') : t('modifiers.created'));
      setOpen(false);
    },
    onError: mutationError(t),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteModifier(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.modifiers() });
      toast(t('modifiers.deleted'));
      setDeleting(null);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={openCreate}>
        <PlusIcon size={14} weight="bold" /> {t('modifiers.new')}
      </Button>
    ),
    [t],
  );

  return (
    <div style={{ height: '100%' }}>
      <CardCollection
        rows={rows}
        loading={list.isLoading}
        error={list.isError}
        onRetry={() => void list.refetch()}
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
              actions={
                <>
                  <RowAction
                    icon={PencilSimpleIcon}
                    label={t('common.edit')}
                    onClick={() => openEdit(r)}
                  />
                  <RowAction
                    icon={TrashIcon}
                    label={t('common.delete')}
                    danger
                    onClick={() => setDeleting(r)}
                  />
                </>
              }
            />
          );
        }}
      />
      <LoadMore
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
      />

      <Modal
        open={open}
        title={editingId !== null ? t('modifiers.edit') : t('modifiers.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
            {editingId !== null ? t('common.save') : t('modifiers.submit')}
          </Button>
        }
      >
        {/* Scope identifies the modifier and is immutable once created. */}
        <TextField
          label={t('modifiers.form.scope')}
          value={scope}
          onChange={setScope}
          disabled={editingId !== null}
        />
        <SelectField
          label={t('modifiers.form.op')}
          value={op}
          onChange={(v) => setOp(v as ModifierOp)}
          options={toOptions(MODIFIER_OPS, t)}
        />
        <TextField label={t('modifiers.form.value')} value={value} onChange={setValue} />
        <TextField label={t('modifiers.form.whenExpr')} value={whenExpr} onChange={setWhenExpr} />
        <TextField label={t('modifiers.form.priority')} value={priority} onChange={setPriority} />
        {editingId !== null && (
          <Toggle checked={active} onChange={setActive} label={t('modifiers.form.active')} />
        )}
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title={t('modifiers.delete.title')}
        message={t('modifiers.delete.message', { scope: deleting?.scope ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={del.isPending}
        onConfirm={() => {
          if (deleting !== null) del.mutate(deleting.id);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
