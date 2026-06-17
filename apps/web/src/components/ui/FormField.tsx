import type { ReactNode } from 'react';
import { useId } from 'react';

import { Tooltip } from './Tooltip';

/**
 * Resolve a stable field id: the explicit one if given, otherwise a generated
 * id that survives re-renders (so labels stay associated with their controls).
 */
export function useFieldId(explicit?: string): string {
  const generated = useId();
  return explicit ?? `ff-${generated}`;
}

/**
 * The shared shell for form fields: a label (with optional required marker),
 * the control, and a single error-or-hint line beneath it. Error wins over hint
 * and renders in `--fail`; hint renders in `--faint`. Field inputs (`TextField`,
 * `NumberField`, `SelectField`, `JsonField`) compose this so label/error/hint
 * are written exactly once.
 */
export function FormField({
  id,
  label,
  error,
  hint,
  required,
  tooltip,
  children,
}: {
  id: string;
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  /** When set, renders a ⓘ Tooltip next to the label text with this description. */
  tooltip?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label !== undefined && (
        <label
          htmlFor={id}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--s-1)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--muted)',
          }}
        >
          {label}
          {required === true && <span style={{ color: 'var(--fail)' }}> *</span>}
          {tooltip !== undefined && <Tooltip text={tooltip} />}
        </label>
      )}
      {children}
      {error !== undefined ? (
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--fail)' }}>{error}</span>
      ) : hint !== undefined ? (
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>{hint}</span>
      ) : null}
    </div>
  );
}
