import { useTranslation } from 'react-i18next';

import { PARAM_FEATURES } from '../../lib/api/enums';
import { FormField, useFieldId } from '../ui/FormField';
import { Toggle } from '../ui/Toggle';

/**
 * A controlled toggle group over the model `param_profile.features` `string[]`
 * (the fine-grained upgrade of the coarse `capabilities` map). It renders one
 * `Toggle` per known {@link PARAM_FEATURES} entry (labelled via i18n), plus a
 * toggle for any *extra* feature string already present in `value` that isn't a
 * known key (so editing a synced profile with unfamiliar features never silently
 * drops them). Toggling adds/removes the key from the array; `onChange` always
 * returns the full updated array. Composed on `FormField` like `CapabilitiesField`.
 */
export function FeaturesField({
  value,
  onChange,
  label,
  tooltip,
  hint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  tooltip?: string;
  hint?: string;
}) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();

  const knownKeys = new Set(PARAM_FEATURES.map((f) => f.key));
  // Unknown features carried on the profile (e.g. from a sync) — surfaced so they
  // stay visible + editable rather than invisibly preserved.
  const extraKeys = value.filter((k) => !knownKeys.has(k));

  const isOn = (key: string) => value.includes(key);
  const set = (key: string, on: boolean) => {
    if (on) {
      if (!value.includes(key)) onChange([...value, key]);
    } else {
      onChange(value.filter((k) => k !== key));
    }
  };

  return (
    <FormField id={fieldId} label={label} tooltip={tooltip} hint={hint}>
      <div
        role="group"
        aria-label={label}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3) var(--s-4)' }}
      >
        {PARAM_FEATURES.map((feat) => (
          <Toggle
            key={feat.key}
            checked={isOn(feat.key)}
            onChange={(on) => set(feat.key, on)}
            label={t(feat.labelKey)}
          />
        ))}
        {extraKeys.map((key) => (
          <Toggle key={key} checked={isOn(key)} onChange={(on) => set(key, on)} label={key} />
        ))}
      </div>
    </FormField>
  );
}
