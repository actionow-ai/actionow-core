import { FormField, useFieldId } from './FormField';
import type { Option } from './Select';
import { Select } from './Select';

export type { Option };

/**
 * A labelled select on the unified field contract, composed on `FormField` so
 * label / error / hint render exactly once and match the other fields. The
 * label's `htmlFor` points at the Select trigger (which takes the FormField id)
 * for a proper label-control association.
 */
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  error,
  hint,
  tooltip,
  inline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  error?: string;
  hint?: string;
  tooltip?: string;
  /** Lay the label to the LEFT of the select (compact filter/toolbar layout). */
  inline?: boolean;
}) {
  const fieldId = useFieldId();
  return (
    <FormField id={fieldId} label={label} error={error} hint={hint} tooltip={tooltip} inline={inline}>
      <Select id={fieldId} value={value} onChange={onChange} options={options} placeholder={placeholder} ariaLabel={label} />
    </FormField>
  );
}
