import type { CSSProperties } from 'react';

/**
 * The shared input style for the unified field contract (TextField, NumberField).
 * Standardizes two things that had drifted: `width: 100%` (so inputs fill the
 * form column instead of rendering at intrinsic ~20-char width, visibly narrow
 * in Modals) and an `error → var(--fail)` border (so a validation error is
 * visible to sighted users, not just `aria-invalid`). The border itself comes
 * from `className="panel"`; this only overrides its colour on error.
 */
export const FIELD_INPUT_BASE: CSSProperties = {
  width: '100%',
  fontSize: 'var(--fs-sm)',
  color: 'var(--text)',
  padding: '9px 11px',
  borderRadius: 'var(--r-sm)',
  outline: 'none',
};

export function fieldInputStyle(error?: string): CSSProperties {
  return error !== undefined
    ? { ...FIELD_INPUT_BASE, borderColor: 'var(--fail)' }
    : FIELD_INPUT_BASE;
}
