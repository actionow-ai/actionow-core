import type { Option } from './Select';
import { Select } from './Select';

export type { Option };

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
      {label}
      <Select value={value} onChange={onChange} options={options} placeholder={placeholder} ariaLabel={label} />
    </label>
  );
}
