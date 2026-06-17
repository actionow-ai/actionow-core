import { CheckIcon, MinusIcon } from '@phosphor-icons/react';

/**
 * A checkbox on the unified contract: `onChange(boolean)`. Rendered as a
 * `role="checkbox"` button so it is keyboard-operable (Space/Enter toggle via
 * the native button), shows the global accent focus ring, and stays on-palette
 * (warm `--accent` fill when checked — never blue). `indeterminate` paints a
 * dash and reports `aria-checked="mixed"` (used by select-all headers).
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  const filled = checked || indeterminate === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate === true ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.55 : 1,
        fontSize: 'var(--fs-sm)',
        color: 'var(--text)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 'var(--r-xs)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink)',
          background: filled ? 'var(--grad-accent)' : 'transparent',
          border: filled ? '1px solid transparent' : '1px solid var(--panel-bd)',
          transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        }}
      >
        {checked ? <CheckIcon size={13} weight="bold" /> : indeterminate === true ? <MinusIcon size={13} weight="bold" /> : null}
      </span>
      {label !== undefined && <span>{label}</span>}
    </button>
  );
}
