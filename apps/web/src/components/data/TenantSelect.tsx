import { useQuery } from '@tanstack/react-query';

import { qk } from '../../lib/api/queryKeys';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { Select } from '../ui/Select';
import { SelectField } from '../ui/SelectField';

/**
 * Tenant picker. With a `label` it renders a stacked field (for forms); without
 * one it renders a compact bare Select (for the TopBar filter slot).
 */
export function TenantSelect({
  label,
  value,
  onChange,
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const api = useAdminApi();
  const { data } = useQuery({ queryKey: qk.tenants(), queryFn: () => api.listTenants() });
  const options = (data ?? []).map((t) => ({ value: t.id, label: t.name }));
  if (label === undefined) {
    return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} ariaLabel={placeholder} />;
  }
  return <SelectField label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} />;
}
