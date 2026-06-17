import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { FormField, useFieldId } from './FormField';
import { IconButton } from './IconButton';
import type { KvRow } from './kvRows';
import { objectFromRows, rowsFromObject } from './kvRows';

const inputStyle = {
  flex: 1,
  minWidth: 0,
  fontSize: 'var(--fs-sm)',
  color: 'var(--text)',
  padding: '9px 11px',
  borderRadius: 'var(--r-sm)',
  outline: 'none',
} as const;

/**
 * An add/remove key→value row editor producing a `Record<string,string>` — the
 * structured replacement for raw-JSON record fields (e.g. a channel `config`).
 * Holds an ordered `KvRow[]` seeded from `value`; every edit emits
 * `onChange(objectFromRows(rows))` (blank keys dropped, last-wins on dup).
 * Optional `presets` are ghost buttons that swap in a preset record. Wrapped in
 * `FormField` for label/tooltip; each input carries an indexed `aria-label`.
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
  value: Record<string, unknown> | undefined;
  onChange: (o: Record<string, string>) => void;
  presets?: { label: string; value: Record<string, string> }[];
}) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();
  const [rows, setRows] = useState<KvRow[]>(() => rowsFromObject(value));

  const apply = (next: KvRow[]) => {
    setRows(next);
    onChange(objectFromRows(next));
  };

  const setRow = (index: number, patch: Partial<KvRow>) => {
    apply(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const addRow = () => apply([...rows, { key: '', value: '' }]);

  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    apply(next.length > 0 ? next : [{ key: '', value: '' }]);
  };

  const usePreset = (preset: Record<string, string>) => apply(rowsFromObject(preset));

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
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
            <input
              id={i === 0 ? fieldId : undefined}
              className="panel"
              aria-label={t('forms.kv.keyAria', { index: i + 1 })}
              placeholder={t('forms.kv.keyPlaceholder')}
              value={row.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
              style={inputStyle}
            />
            <input
              className="panel"
              aria-label={t('forms.kv.valueAria', { index: i + 1 })}
              placeholder={t('forms.kv.valuePlaceholder')}
              value={row.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              style={inputStyle}
            />
            <IconButton icon={XIcon} label={t('forms.removeRow')} onClick={() => removeRow(i)} size={16} />
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
