import type { Icon } from '@phosphor-icons/react';

/**
 * The shared square icon button (the `.ico-btn` pattern from the console rail +
 * top bar). Always has an accessible name via `aria-label`; an optional
 * `tooltip` slides out on hover/focus (the rail's `.ico-tip`). `active` paints
 * the on-palette active state. Pass `aria-current="page"` semantics via
 * `current`.
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
}) {
  return (
    <button
      type={type}
      className={`ico-btn${active === true ? ' is-active' : ''}`}
      aria-label={label}
      aria-current={current === true ? 'page' : undefined}
      onClick={onClick}
    >
      <IconCmp size={size} weight={weight} />
      {tooltip === true && <span className="ico-tip">{label}</span>}
    </button>
  );
}
