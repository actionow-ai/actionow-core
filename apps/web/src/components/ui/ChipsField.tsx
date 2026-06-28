import { PlusIcon, XIcon } from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FormField, useFieldId } from './FormField';

/**
 * A free add/remove string-list editor producing `string[]` — the structured
 * replacement for comma-separated text fields (e.g. `execModes`, enum
 * `options`, matrix `key`). Type a value and press Enter or comma to add it
 * (trimmed; empty and duplicate values are ignored); each chip has a remove
 * button; optional `suggestions` not already chosen render as add-on-click
 * chips below. Wrapped in `FormField` for label/tooltip/hint — never blue.
 */
export function ChipsField({
  label,
  tooltip,
  hint,
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  label?: string;
  tooltip?: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();
  const [draft, setDraft] = useState('');

  const add = (raw: string) => {
    const v = raw.trim();
    if (v === '' || value.includes(v)) return;
    onChange([...value, v]);
  };

  const remove = (chip: string) => onChange(value.filter((v) => v !== chip));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
      setDraft('');
    } else if (e.key === 'Backspace' && draft === '') {
      e.preventDefault();
      const last = value.at(-1);
      if (last !== undefined) remove(last);
    }
  };

  const open = (suggestions ?? []).filter((s) => !value.includes(s));

  return (
    <FormField id={fieldId} label={label} tooltip={tooltip} hint={hint}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <div
          className="field"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--s-2)',
            padding: 'var(--s-2)',
            borderRadius: 'var(--r-sm)',
            minHeight: 40,
          }}
        >
          {value.map((chip) => (
            <button
              key={chip}
              type="button"
              className="hit-slop"
              aria-label={t('forms.removeChip', { value: chip })}
              onClick={() => remove(chip)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--s-1)',
                padding: '3px 9px',
                borderRadius: 'var(--r-pill)',
                fontSize: 'var(--fs-caption)',
                color: 'var(--text)',
                background: 'var(--hover-bg)',
                border: '1px solid var(--panel-bd)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <span>{chip}</span>
              <XIcon size={12} weight="bold" aria-hidden="true" style={{ color: 'var(--muted)' }} />
            </button>
          ))}
          <input
            id={fieldId}
            value={draft}
            placeholder={placeholder ?? t('forms.chipsPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            style={{
              flex: 1,
              minWidth: 80,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 'var(--fs-sm)',
            }}
          />
        </div>
        {open.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)' }}>
            {open.map((s) => (
              <button
                key={s}
                type="button"
                className="hit-slop"
                aria-label={t('forms.addChip', { value: s })}
                onClick={() => add(s)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--s-1)',
                  padding: '3px 9px',
                  borderRadius: 'var(--r-pill)',
                  fontSize: 'var(--fs-caption)',
                  fontWeight: 'var(--fw-medium)',
                  color: 'var(--accent-2)',
                  background: 'transparent',
                  border: '1px dashed var(--hover-bd)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <PlusIcon size={11} weight="bold" aria-hidden="true" />
                <span>{s}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </FormField>
  );
}
