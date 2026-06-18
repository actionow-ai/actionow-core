import type { Icon } from '@phosphor-icons/react';

/**
 * The shared square icon button (the `.ico-btn` pattern from the console rail +
 * top bar). Always has an accessible name via `aria-label`; an optional
 * `tooltip` slides out on hover/focus (the rail's `.ico-tip`). `active` paints
 * the on-palette active state. Pass `aria-current="page"` semantics via
 * `current`.
 *
 * Note: `.ico-tip` is a right-slide CSS tooltip used ONLY by the rail, which has
 * no `overflow:auto/hidden` ancestor — so it isn't clipped and stays inline
 * (the portaled `Floating` primitive only flips top/bottom). Buttons WITHOUT the
 * custom tooltip get a native `title={label}` so every icon button has a
 * hover/long-press affordance (matching RowAction); when the custom `.ico-tip`
 * is shown we drop the native title to avoid a double tooltip.
 */
export function IconButton({
  icon: IconCmp,
  label,
  onClick,
  active,
  current,
  tooltip,
  size = 18,
  type = 'button',
  weight,
  ariaHasPopup,
  ariaExpanded,
  ariaControls,
}: {
  icon: Icon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  current?: boolean;
  tooltip?: boolean;
  size?: number;
  type?: 'button' | 'submit';
  weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';
  /** Disclosure semantics when this button toggles a popover/menu. */
  ariaHasPopup?: boolean | 'menu' | 'listbox' | 'dialog' | 'grid' | 'tree';
  ariaExpanded?: boolean;
  ariaControls?: string;
}) {
  return (
    <button
      type={type}
      className={`ico-btn hit-slop${active === true ? ' is-active' : ''}`}
      aria-label={label}
      title={tooltip === true ? undefined : label}
      aria-current={current === true ? 'page' : undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      onClick={onClick}
    >
      <IconCmp size={size} weight={weight} />
      {tooltip === true && <span className="ico-tip">{label}</span>}
    </button>
  );
}
