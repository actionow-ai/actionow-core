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

/** Deterministic id of a field's error/hint message span, derived from the field id. */
export function fieldMsgId(id: string): string {
  return `${id}-msg`;
}

/**
 * ARIA wiring shared by every unified field control. Marks the control invalid
 * when there is an error and points `aria-describedby` at the `FormField` message
 * span (error or hint) so screen readers announce it on focus. Centralises the
 * WCAG 1.3.1 / 3.3.1 field-error association so each field spreads `fieldAria(...)`.
 */
export function fieldAria(
  id: string,
  error?: string,
  hint?: string,
): { 'aria-invalid': true | undefined; 'aria-describedby': string | undefined } {
  const hasMessage = error !== undefined || hint !== undefined;
  return {
    'aria-invalid': error !== undefined ? true : undefined,
    'aria-describedby': hasMessage ? fieldMsgId(id) : undefined,
  };
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
  inline = false,
  children,
}: {
  id: string;
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  /** When set, renders a ⓘ Tooltip next to the label text with this description. */
  tooltip?: string;
  /**
   * Lay the label to the LEFT of the control (a centred flex row) instead of
   * above it. Used by compact filter/toolbar selects (e.g. 状态 in the TopBar
   * filter slot). Default keeps the label-above stack so no other field shifts.
   */
  inline?: boolean;
  children: ReactNode;
}) {
  const labelNode = label !== undefined && (
    <label
      htmlFor={id}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        fontSize: 'var(--fs-sm)',
        fontWeight: 'var(--fw-medium)',
        color: 'var(--muted)',
        // In inline mode the label sits beside the control and must not stretch
        // to full width or wrap, so the select keeps its natural size.
        ...(inline ? { flexShrink: 0, whiteSpace: 'nowrap' } : null),
      }}
    >
      {label}
      {required === true && <span style={{ color: 'var(--fail)' }}> *</span>}
      {tooltip !== undefined && <Tooltip text={tooltip} />}
    </label>
  );
  const tail =
    error !== undefined ? (
      <span id={fieldMsgId(id)} style={{ fontSize: 'var(--fs-caption)', color: 'var(--fail)' }}>
        {error}
      </span>
    ) : hint !== undefined ? (
      <span id={fieldMsgId(id)} style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
        {hint}
      </span>
    ) : null;

  if (inline) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          {labelNode}
          <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        </div>
        {tail}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {labelNode}
      {children}
      {tail}
    </div>
  );
}
