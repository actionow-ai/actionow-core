import { FIELD_INPUT_BASE } from './fieldStyles';
import { fieldAria, FormField, useFieldId } from './FormField';

/**
 * A single-line text input on the unified field contract: `onChange(value)`
 * (the DOM event is adapted internally) wrapped in `FormField` for label /
 * error / hint / required. No arbitrary attribute spread — only the props a
 * text field actually needs are exposed (numeric inputs use `NumberField`).
 */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  tooltip,
  required,
  type = 'text',
  placeholder,
  autoComplete,
  disabled,
  minLength,
  maxLength,
  id,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  tooltip?: string;
  required?: boolean;
  type?: 'text' | 'email' | 'password' | 'url' | 'tel' | 'search';
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  minLength?: number;
  maxLength?: number;
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
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        {...fieldAria(fieldId, error, hint)}
        onChange={(e) => onChange(e.target.value)}
        className="field"
        style={FIELD_INPUT_BASE}
      />
    </FormField>
  );
}
