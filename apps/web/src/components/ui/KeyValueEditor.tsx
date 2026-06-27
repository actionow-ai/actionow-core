import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { FormField, useFieldId } from './FormField';
import type { KvRow } from './kvRows';
import { blankRow, rowsFromObject } from './kvRows';
import { RowAction } from './RowAction';

// Surface (glass bg, border, r-sm, focus ring) comes from the `.field` class;
// keys/values are code so the inputs are mono, at the design's KV row height.
const inputStyle = {
  flex: 1,
  minWidth: 0,
  fontSize: 'var(--fs-sm)',
  fontFamily: 'ui-monospace, Menlo, monospace',
  color: 'var(--text)',
  padding: '9px 11px',
  minHeight: 40,
} as const;

const BLANK_ROW: KvRow = blankRow();

/**
 * A fully controlled add/remove key→value row editor — the structured
 * replacement for raw-JSON record fields (e.g. a channel `config`). The parent
 * owns the ordered `KvRow[]` (seed via `rowsFromObject(existing)`, collapse via
 * `objectFromRows(rows)` at submit); this component renders straight from
 * `value` and emits a fresh `KvRow[]` on every edit (no internal state). An
 * empty `value` still shows one editable blank row; the first edit emits the
 * full array. Optional `presets` are ghost buttons that swap in a preset
 * record. Wrapped in `FormField`; each input carries an indexed `aria-label`.
 */
export function KeyValueEditor({
  label,
  tooltip,
  hint,
  value,
  onChange,
  presets,
}: {
  label?: string;
  tooltip?: string;
  hint?: string;
  value: KvRow[];
  onChange: (rows: KvRow[]) => void;
  presets?: { label: string; value: Record<string, string> }[];
}) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();
  const rows = value.length > 0 ? value : [BLANK_ROW];

  const setRow = (index: number, patch: Partial<KvRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const addRow = () => onChange([...rows, blankRow()]);

  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : [blankRow()]);
  };

  const usePreset = (preset: Record<string, string>) => onChange(rowsFromObject(preset));

  return (
    <FormField id={fieldId} label={label} tooltip={tooltip} hint={hint}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {presets !== undefined && presets.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)' }}>
            {presets.map((p) => (
              <Button key={p.label} variant="ghost" size="sm" onClick={() => usePreset(p.value)}>
                {p.label}
              </Button>
            ))}
          </div>
        )}
        {rows.map((row, i) => (
          <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
            <input
              id={i === 0 ? fieldId : undefined}
              className="field"
              aria-label={t('forms.kv.keyAria', { index: i + 1 })}
              placeholder={t('forms.kv.keyPlaceholder')}
              value={row.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
              style={inputStyle}
            />
            <span aria-hidden="true" style={{ color: 'var(--faint)', flexShrink: 0 }}>
              =
            </span>
            <input
              className="field"
              aria-label={t('forms.kv.valueAria', { index: i + 1 })}
              placeholder={t('forms.kv.valuePlaceholder')}
              value={row.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              style={inputStyle}
            />
            <RowAction
              icon={XIcon}
              label={t('forms.removeRow')}
              onClick={() => removeRow(i)}
              danger
            />
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" onClick={addRow}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" />
            {t('forms.addRow')}
          </Button>
        </div>
      </div>
    </FormField>
  );
}
