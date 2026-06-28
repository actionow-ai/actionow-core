import type { KeyboardEvent, ReactNode } from 'react';
import { useId, useRef } from 'react';

import { useReducedMotion } from '../../lib/motion/useReducedMotion';

export interface Tab {
  value: string;
  label: string;
}

/**
 * A controlled, ARIA-correct tab strip with a warm active underline. Keyboard:
 * arrow keys move (and wrap) the selection, Home/End jump to ends; the selected
 * tab is the only roving tab stop. `children` is the active tab's panel content
 * — the caller swaps it when `onChange` fires.
 */
export function Tabs({
  value,
  onChange,
  tabs,
  children,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  tabs: Tab[];
  children: ReactNode;
  ariaLabel?: string;
}) {
  const reduced = useReducedMotion();
  const base = useId();
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIdx = Math.max(
    tabs.findIndex((tb) => tb.value === value),
    0,
  );
  const tabId = (v: string) => `${base}-tab-${v}`;
  const panelId = `${base}-panel-${tabs[activeIdx]?.value ?? ''}`;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    let next = activeIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (activeIdx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (activeIdx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const tb = tabs[next];
    if (tb === undefined) return;
    onChange(tb.value);
    // Carry DOM focus to the newly-selected tab. After the re-render it becomes
    // the only tab stop (tabIndex=0); without this, focus is stranded on the
    // now-tabIndex=-1 tab. Focusing by index here never fires on mouse clicks.
    btnRefs.current[next]?.focus();
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label={ariaLabel}
        style={{
          display: 'flex',
          gap: 'var(--s-5)',
          borderBottom: '1px solid var(--row-bd)',
          overflowX: 'auto',
        }}
      >
        {tabs.map((tb, i) => {
          const on = i === activeIdx;
          return (
            <button
              key={tb.value}
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tb.value)}
              aria-selected={on}
              aria-controls={on ? panelId : undefined}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(tb.value)}
              onKeyDown={onKeyDown}
              style={{
                position: 'relative',
                padding: '11px 4px',
                minHeight: 44,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 'var(--fs-sm)',
                fontWeight: 'var(--fw-medium)',
                whiteSpace: 'nowrap',
                color: on ? 'var(--text)' : 'var(--muted)',
                transition: reduced ? 'none' : `color var(--dur-fast) var(--ease-out)`,
              }}
            >
              {tb.label}
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: -1,
                  height: 2,
                  borderRadius: 'var(--r-pill)',
                  background: 'var(--grad-accent)',
                  opacity: on ? 1 : 0,
                  transition: reduced ? 'none' : `opacity var(--dur-fast) var(--ease-out)`,
                }}
              />
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(tabs[activeIdx]?.value ?? '')}
        style={{ marginTop: 'var(--s-4)' }}
      >
        {children}
      </div>
    </div>
  );
}
