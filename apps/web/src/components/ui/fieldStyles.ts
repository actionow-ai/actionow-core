import type { CSSProperties } from 'react';

/**
 * Inline style shared by unified field controls (TextField, NumberField,
 * ComboboxField, the Select trigger, the AnalyticsPage date inputs).
 *
 * The visual surface — glass background, 1px border, `--r-sm` radius, 42px
 * min-height, 10/12 padding, the warm focus ring and the error red-ring — now
 * lives in the `.field` CSS class (`styles/glass.css`); the error ring is driven
 * by the control's `aria-invalid` attribute. This object carries only what a
 * shared class can't cleanly: full-width fill, font size and text colour.
 */
export const FIELD_INPUT_BASE: CSSProperties = {
  width: '100%',
  fontSize: 'var(--fs-sm)',
  color: 'var(--text)',
};
