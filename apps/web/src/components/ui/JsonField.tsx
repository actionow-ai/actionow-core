import type { CSSProperties } from 'react';

import { FormField, useFieldId } from './FormField';

export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse a JSON textarea value. Empty -> ok/undefined (caller decides if required). */
export function validateJson(raw: string): JsonResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

// Surface (glass bg, border, r-sm, focus/error rings) comes from the `.field`
// class; this carries only the textarea-specific shape (multiline, mono, resize).
const taStyle: CSSProperties = {
  width: '100%',
  minHeight: 120,
  resize: 'vertical',
  fontSize: 'var(--fs-sm)',
  lineHeight: 1.6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--text)',
  padding: 'var(--s-3)',
};

export function JsonField({
  label,
  value,
  onChange,
  error,
  hint,
  tooltip,
  required,
  placeholder,
  id,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  tooltip?: string;
  required?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <FormField id={fieldId} label={label} error={error} hint={hint} tooltip={tooltip} required={required}>
      <textarea
        id={fieldId}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        required={required}
        aria-invalid={error !== undefined ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="field"
        style={taStyle}
      />
    </FormField>
  );
}
