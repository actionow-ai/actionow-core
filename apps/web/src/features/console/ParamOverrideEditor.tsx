import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { NumberField } from '../../components/ui/NumberField';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ParamOpDef } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

type OpKind = 'set' | 'clamp' | 'delete';

/** A draft override op row (the editable superset of `ParamOpDef`). */
interface OpDraft {
  op: OpKind;
  name: string;
  /** `set` value, kept as raw text; parsed to number/bool/JSON at submit. */
  value: string;
  /** `clamp` bounds (empty string = unset). */
  min: string;
  max: string;
  /** `when.modelMatches` (empty = unconditional). */
  when: string;
}

const EMPTY_OP: OpDraft = { op: 'set', name: '', value: '', min: '', max: '', when: '' };

/** Coerce a raw `set` value string to number / boolean / JSON / string. */
function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed === String(num)) return num;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Render a stored `set` value back into the raw text input. */
function valueToText(value: unknown): string {
  if (value === undefined || value === null) return value === null ? 'null' : '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** One stored `ParamOpDef` → an editable draft row. */
function toDraft(op: ParamOpDef): OpDraft {
  return {
    op: op.op,
    name: op.name,
    value: valueToText(op.value),
    min: op.min === undefined ? '' : String(op.min),
    max: op.max === undefined ? '' : String(op.max),
    when: op.when?.modelMatches ?? '',
  };
}

/** A draft row → the wire `ParamOpDef` (dropping empty optional fields). */
function fromDraft(d: OpDraft): ParamOpDef {
  const op: ParamOpDef = { op: d.op, name: d.name.trim() };
  if (d.op === 'set') op.value = coerceValue(d.value);
  if (d.op === 'clamp') {
    if (d.min.trim() !== '') op.min = Number(d.min);
    if (d.max.trim() !== '') op.max = Number(d.max);
  }
  if (d.when.trim() !== '') op.when = { modelMatches: d.when.trim() };
  return op;
}

/**
 * The per-(model×channel) 参数覆盖 editor (模型参数绑定 Phase 0). A `Drawer` that
 * edits `channel_model.param_override` — a list of `set`/`clamp`/`delete` ops (with
 * an optional `when.modelMatches` condition). Reachable from ModelAccessPage col-3
 * (a channel-model row); the override is per-(model,channel) so it always carries
 * the selected channel. Saving an EMPTY op list clears the override (== today).
 */
export function ParamOverrideEditor({
  resourceId,
  channelId,
  modelId,
  modelName,
  onClose,
}: {
  resourceId: string;
  channelId: string;
  modelId: string;
  modelName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: qk.channelModelOverride(channelId, modelId),
    // The current override is read off the channel's model list row (which carries
    // param_override), so no dedicated GET endpoint is needed.
    queryFn: async () => {
      const rows = await api.listChannelModels(resourceId, channelId);
      return rows.find((m) => m.id === modelId)?.param_override ?? null;
    },
  });

  const [rows, setRows] = useState<OpDraft[]>([]);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || query.data === undefined) return;
    setRows((query.data?.ops ?? []).map(toDraft));
    setSeeded(true);
  }, [seeded, query.data]);

  const save = useMutation({
    mutationFn: () => {
      const ops = rows.filter((r) => r.name.trim() !== '').map(fromDraft);
      // An empty ops list clears the override (== 现状).
      return api.setChannelModelOverride(resourceId, channelId, modelId, {
        paramOverride: ops.length === 0 ? null : { ops },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.channelModels(channelId) });
      void qc.invalidateQueries({ queryKey: qk.channelModelOverride(channelId, modelId) });
      toast(t('override.saved'));
      onClose();
    },
    onError: mutationError(t),
  });

  const opOptions = [
    { value: 'set', label: t('override.op_set') },
    { value: 'clamp', label: t('override.op_clamp') },
    { value: 'delete', label: t('override.op_delete') },
  ];

  function patchRow(index: number, patch: Partial<OpDraft>): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <Drawer
      open
      title={t('override.editTitle', { model: modelName })}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
        {t('override.hint')}
      </p>

      {rows.map((row, index) => (
        <div
          key={index}
          className="panel"
          style={{
            borderRadius: 'var(--r-sm)',
            padding: 'var(--s-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-2)' }}>
            <div style={{ flex: '0 0 130px' }}>
              <SelectField
                inline
                label={t('override.op')}
                value={row.op}
                onChange={(v) => patchRow(index, { op: v as OpKind })}
                options={opOptions}
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                label={t('override.opName')}
                value={row.name}
                onChange={(v) => patchRow(index, { name: v })}
                placeholder="temperature"
              />
            </div>
            <div style={{ paddingTop: 'var(--s-5)' }}>
              <RowAction
                icon={TrashIcon}
                label={t('common.delete')}
                danger
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              />
            </div>
          </div>

          {row.op === 'set' && (
            <TextField
              label={t('override.opValue')}
              value={row.value}
              onChange={(v) => patchRow(index, { value: v })}
              hint={t('override.opValueHint')}
            />
          )}
          {row.op === 'clamp' && (
            <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
              <div style={{ flex: 1 }}>
                <NumberField
                  label={t('override.opMin')}
                  value={row.min === '' ? Number.NaN : Number(row.min)}
                  onChange={(v) => patchRow(index, { min: Number.isNaN(v) ? '' : String(v) })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <NumberField
                  label={t('override.opMax')}
                  value={row.max === '' ? Number.NaN : Number(row.max)}
                  onChange={(v) => patchRow(index, { max: Number.isNaN(v) ? '' : String(v) })}
                />
              </div>
            </div>
          )}

          <TextField
            label={t('override.when')}
            value={row.when}
            onChange={(v) => patchRow(index, { when: v })}
            hint={t('override.whenHint')}
          />
        </div>
      ))}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setRows((prev) => [...prev, { ...EMPTY_OP }])}
      >
        <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('override.addOp')}
      </Button>
    </Drawer>
  );
}
