import { FIELD_INPUT_BASE } from './fieldStyles';
import { fieldAria, FormField, useFieldId } from './FormField';

/**
 * A numeric input on the unified field contract: `onChange(number)` (replacing
 * the `type="number"` escape hatch on `TextField`). An empty/invalid input
 * emits `0` — documented so callers never receive `NaN`. Composes `FormField`
 * for label / error / hint / required.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  error,
  hint,
  tooltip,
  required,
  disabled,
  id,
}: {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  error?: string;
  hint?: string;
  tooltip?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <FormField
      id={fieldId}
      label={label}
      error={error}
      hint={hint}
      tooltip={tooltip}
      required={required}
    >
      <input
        id={fieldId}
        type="number"
        value={Number.isNaN(value) ? '' : value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        required={required}
        {...fieldAria(fieldId, error, hint)}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          onChange(Number.isNaN(n) ? 0 : n);
        }}
        className="field tabular"
        style={FIELD_INPUT_BASE}
      />
    </FormField>
  );
}
