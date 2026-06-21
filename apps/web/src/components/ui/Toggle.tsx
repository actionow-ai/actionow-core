/**
 * A switch on the unified contract: `onChange(boolean)`. Rendered as a
 * `role="switch"` button so it is keyboard-operable (Space/Enter toggle), shows
 * the global accent focus ring, and stays on-palette (warm `--accent` track
 * when on — never blue).
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="hit-slop"
      aria-checked={checked}
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
          position: 'relative',
          width: 46,
          height: 26,
          flexShrink: 0,
          borderRadius: 'var(--r-pill)',
          background: checked ? 'var(--grad-accent)' : 'var(--panel-bd)',
          transition: 'background var(--dur-base) var(--ease-out)',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            transform: checked ? 'translateX(20px)' : 'translateX(0)',
            transition: 'transform var(--dur-base) var(--ease-out)',
            boxShadow: 'var(--shadow-lift)',
          }}
        />
      </span>
      {label !== undefined && <span>{label}</span>}
    </button>
  );
}
