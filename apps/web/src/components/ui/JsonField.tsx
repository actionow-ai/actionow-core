import type { CSSProperties } from 'react';

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

const taStyle: CSSProperties = {
  width: '100%',
  minHeight: 120,
  resize: 'vertical',
  fontSize: 12,
  lineHeight: 1.6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--text)',
  background: 'var(--panel-bg)',
  border: '1px solid var(--panel-bd)',
  borderRadius: 'var(--r-sm)',
  padding: 'var(--s-3)',
};

export function JsonField({
  label,
  value,
  onChange,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block', fontSize: 12.5 }}>
      <span style={{ display: 'block', color: 'var(--muted)', marginBottom: 6 }}>{label}</span>
      <textarea
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={error !== undefined ? { ...taStyle, borderColor: 'var(--accent-2)' } : taStyle}
      />
      {error !== undefined && (
        <span style={{ display: 'block', color: 'var(--accent-2)', fontSize: 11, marginTop: 4 }}>{error}</span>
      )}
    </label>
  );
}
