import { InfoIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';

/**
 * A small info affordance: a Phosphor `InfoIcon` button (or a custom
 * `children` trigger) that reveals a `role="tooltip"` bubble on hover/focus.
 * The trigger carries `aria-label={text}` (so it has an accessible name) and
 * `aria-describedby` pointing at the always-rendered bubble, which toggles
 * `data-open`. The opacity transition uses `--dur-fast`; the global
 * reduced-motion safety net collapses it to instant. Warm `--overlay-bg`
 * bubble, `--fs-caption` — never blue.
 */
export function Tooltip({ text, children }: { text: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={text}
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'help',
          color: 'var(--muted)',
          lineHeight: 0,
        }}
      >
        {children ?? <InfoIcon size={15} weight="regular" aria-hidden="true" />}
      </button>
      <span
        id={tipId}
        role="tooltip"
        data-open={open ? 'true' : 'false'}
        style={{
          position: 'absolute',
          bottom: 'calc(100% + var(--s-2))',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 95,
          maxWidth: 240,
          width: 'max-content',
          padding: 'var(--s-2) var(--s-3)',
          borderRadius: 'var(--r-sm)',
          background: 'var(--overlay-bg)',
          border: '1px solid var(--panel-bd)',
          boxShadow: 'var(--glass-shadow)',
          color: 'var(--text)',
          fontSize: 'var(--fs-caption)',
          lineHeight: 1.4,
          textAlign: 'left',
          whiteSpace: 'normal',
          pointerEvents: 'none',
          opacity: open ? 1 : 0,
          visibility: open ? 'visible' : 'hidden',
          transition: 'opacity var(--dur-fast) var(--ease-out), visibility var(--dur-fast) var(--ease-out)',
        }}
      >
        {text}
      </span>
    </span>
  );
}
