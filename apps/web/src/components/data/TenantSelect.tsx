import { useQuery } from '@tanstack/react-query';

import { useAdminApi } from '../../lib/api/useAdminApi';
import { SelectField } from '../ui/SelectField';

export function TenantSelect({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const api = useAdminApi();
  const { data } = useQuery({ queryKey: ['tenants'], queryFn: () => api.listTenants() });
  const options = (data ?? []).map((t) => ({ value: t.id, label: t.name }));
  return <SelectField label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} />;
}
