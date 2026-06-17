import { FormField, useFieldId } from './FormField';

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
  required,
  type = 'text',
  placeholder,
  autoComplete,
  disabled,
  id,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: 'text' | 'email' | 'password' | 'url' | 'tel' | 'search';
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  id?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <FormField id={fieldId} label={label} error={error} hint={hint} required={required}>
      <input
        id={fieldId}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        required={required}
        aria-invalid={error !== undefined ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="panel"
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--text)',
          padding: '9px 11px',
          borderRadius: 'var(--r-sm)',
          outline: 'none',
        }}
      />
    </FormField>
  );
}
