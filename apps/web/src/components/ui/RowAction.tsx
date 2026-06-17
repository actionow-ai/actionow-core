import { CircleNotchIcon, type Icon } from '@phosphor-icons/react';

/**
 * A compact (30px) icon-only button for a `DataTable` row-actions cell. Text
 * buttons don't fit when a row has several actions — they wrap and blow up the
 * row height — so actions render as icons with the accessible name on both
 * `aria-label` and a native `title` tooltip. `danger` tints the hover red
 * (delete); `loading` swaps the icon for a spinner and disables the button.
 */
export function RowAction({
  icon: IconCmp,
  label,
  onClick,
  loading,
  danger,
  disabled,
}: {
  icon: Icon;
  label: string;
  onClick: () => void;
  loading?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const blocked = disabled === true || loading === true;
  return (
    <button
      type="button"
      className="row-action"
      data-danger={danger === true ? '' : undefined}
      aria-label={label}
      title={label}
      disabled={blocked}
      onClick={onClick}
    >
      {loading === true ? (
        <CircleNotchIcon size={15} weight="bold" className="refresh-spin" aria-hidden="true" />
      ) : (
        <IconCmp size={15} weight="bold" aria-hidden="true" />
      )}
    </button>
  );
}
