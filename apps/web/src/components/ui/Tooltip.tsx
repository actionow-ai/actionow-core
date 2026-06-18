import { InfoIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import { Floating } from './Floating';

/**
 * A small info affordance: a Phosphor `InfoIcon` button (or a custom
 * `children` trigger) that reveals a `role="tooltip"` bubble on hover/focus/tap.
 * The trigger carries `aria-label={text}` (accessible name) and
 * `aria-describedby` pointing at the bubble, which is **portaled to <body> via
 * `Floating`** so it escapes the `overflow:auto` clip of a Modal/Drawer/console
 * scrollport (the old inline `position:absolute` bubble was truncated there).
 * `keepMounted` keeps the bubble in the DOM (visibility-hidden) so the
 * `aria-describedby` relationship stays valid while closed. `Floating` flips
 * top↔bottom and clamps to the viewport. `onClick` toggles it for touch (no
 * hover). Warm `--overlay-bg` bubble, `--fs-caption` — never blue.
 */
export function Tooltip({ text, children }: { text: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="hit-slop"
        aria-label={text}
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Touch has no hover: tap toggles the bubble (blur dismisses it).
        onClick={() => setOpen((v) => !v)}
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
      <Floating
        open={open}
        keepMounted
        triggerRef={triggerRef}
        placement="top"
        align="center"
        gap={8}
        margin={8}
        layer="tooltip"
        role="tooltip"
        id={tipId}
        style={{
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
          transition: 'opacity var(--dur-fast) var(--ease-out)',
        }}
      >
        {text}
      </Floating>
    </span>
  );
}
