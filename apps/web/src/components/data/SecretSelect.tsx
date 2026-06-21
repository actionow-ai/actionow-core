import { useQuery } from '@tanstack/react-query';

import { qk } from '../../lib/api/queryKeys';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { Select } from '../ui/Select';
import { SelectField } from '../ui/SelectField';

/**
 * Credential (secret) picker — choose an EXISTING secret by its reference id
 * instead of re-typing it. Mirrors `TenantSelect`: with a `label` it renders a
 * stacked form field; without one, a compact bare Select. The option label
 * carries the provider for context (the secret value is never returned).
 */
export function SecretSelect({
  label,
  value,
  onChange,
  placeholder,
  tooltip,
  hint,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  tooltip?: string;
  hint?: string;
}) {
  const api = useAdminApi();
  const { data } = useQuery({
    queryKey: qk.secrets(),
    queryFn: () => api.listSecrets(),
    staleTime: STALE_REFERENCE,
  });
  const options = (data ?? []).map((s) => ({ value: s.id, label: `${s.id} · ${s.provider}` }));
  // Always surface the currently-set credential even if it's not in the loaded
  // page (beyond the first page, or since-revoked) so editing never hides what's
  // actually set — otherwise the picker would render an empty placeholder.
  if (value !== '' && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: value });
  }
  if (label === undefined) {
    return (
      <Select
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        ariaLabel={placeholder}
      />
    );
  }
  return (
    <SelectField
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      tooltip={tooltip}
      hint={hint}
    />
  );
}
