import { useQuery } from '@tanstack/react-query';

import { qk } from '../../lib/api/queryKeys';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { FormField, useFieldId } from '../ui/FormField';
import { BrandIcon } from './BrandIcon';

/**
 * A grid picker for the seeded icon catalog (`GET /admin/icons`). Selecting a
 * tile sets `value` to that `icon_asset.key`; the first tile (无 / 继承) clears
 * it (`null`) so the entity falls back to its derived/inherited brand icon.
 * Composes {@link FormField} for the label/tooltip/hint shell and renders each
 * option via {@link BrandIcon}.
 */
export function IconPicker({
  label,
  tooltip,
  hint,
  value,
  onChange,
  /** Shown on the cleared tile + as the live fallback preview when no icon is set. */
  fallbacks = [],
}: {
  label?: string;
  tooltip?: string;
  hint?: string;
  value: string | null;
  onChange: (key: string | null) => void;
  fallbacks?: (string | null | undefined)[];
}) {
  const api = useAdminApi();
  const id = useFieldId();
  const icons = useQuery({
    queryKey: qk.icons(),
    queryFn: () => api.listIcons(),
    staleTime: STALE_REFERENCE,
  });

  const tile = (
    key: string | null,
    label: string,
    selected: boolean,
    node: React.ReactNode,
  ) => (
    <button
      key={key ?? '__none__'}
      type="button"
      className={`icon-pick${selected ? ' is-selected' : ''}`}
      title={label}
      aria-pressed={selected}
      onClick={() => onChange(key)}
    >
      {node}
    </button>
  );

  return (
    <FormField id={id} label={label} tooltip={tooltip} hint={hint}>
      <div className="icon-pick-grid" role="group" id={id}>
        {tile(
          null,
          '继承 / 默认',
          value === null,
          <BrandIcon icon={null} fallbacks={fallbacks} size={20} />,
        )}
        {(icons.data ?? []).map((ic) =>
          tile(ic.key, ic.label, value === ic.key, <BrandIcon icon={ic.key} size={20} />),
        )}
      </div>
    </FormField>
  );
}
