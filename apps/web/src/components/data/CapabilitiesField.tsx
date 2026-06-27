import { useTranslation } from 'react-i18next';

import { CAPABILITIES } from '../../lib/api/enums';
import { FormField, useFieldId } from '../ui/FormField';
import { Toggle } from '../ui/Toggle';

/**
 * A controlled toggle group over a free-form `Record<string, boolean>` model
 * `capabilities` map — the structured replacement for a raw JSON editor. It
 * renders one `Toggle` per known {@link CAPABILITIES} flag (labelled via i18n),
 * plus a toggle for any *extra* key already present in `value` that isn't a
 * known flag (so editing a synced model with unfamiliar flags never silently
 * drops them). `onChange` always returns the full updated record: known flags
 * carry explicit `true`/`false`, extras are preserved verbatim. Composed on
 * `FormField` for a labelled field consistent with the rest of the toolkit.
 */
export function CapabilitiesField({
  value,
  onChange,
  label,
  tooltip,
  hint,
}: {
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  label?: string;
  tooltip?: string;
  hint?: string;
}) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();

  const knownKeys = new Set(CAPABILITIES.map((c) => c.key));
  // Unknown flags carried on the model (e.g. from a sync) — surfaced so they're
  // visible and editable rather than invisibly preserved.
  const extraKeys = Object.keys(value).filter((k) => !knownKeys.has(k));

  // A key absent from the record reads as off. `value[k]` is typed `boolean` by
  // the index signature, so guard membership before reading to handle the real
  // runtime `undefined` of a missing flag.
  const isOn = (key: string) => Object.hasOwn(value, key) && value[key] === true;
  const set = (key: string, on: boolean) => onChange({ ...value, [key]: on });

  return (
    <FormField id={fieldId} label={label} tooltip={tooltip} hint={hint}>
      <div
        role="group"
        aria-label={label}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3) var(--s-4)' }}
      >
        {CAPABILITIES.map((cap) => (
          <Toggle
            key={cap.key}
            checked={isOn(cap.key)}
            onChange={(on) => set(cap.key, on)}
            label={t(cap.labelKey)}
          />
        ))}
        {extraKeys.map((key) => (
          <Toggle key={key} checked={isOn(key)} onChange={(on) => set(key, on)} label={key} />
        ))}
      </div>
    </FormField>
  );
}
