import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

export interface Segment {
  value: string;
  label: string;
}

/**
 * A radiogroup of segment buttons (the design's `.seg`): an inline-flex glass
 * box with a static per-button accent fill on the selected segment — no sliding
 * indicator. On the unified contract: `onChange(value)`. Keyboard: arrow keys
 * move (and wrap) the selection; the active option is the only roving tab stop.
 * Warm `--accent` fill, never blue.
 */
export function SegmentedControl({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Segment[];
  ariaLabel?: string;
}) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIdx = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );

  // Move the roving selection AND DOM focus to `next`. The newly-selected button
  // becomes the only tab stop (tabIndex=0) after the re-render, so a keyboard
  // move must carry focus with it — otherwise focus is stranded on the
  // now-tabIndex=-1 button. Focusing here (synchronously, by index) sidesteps the
  // controlled-rerender timing problem and never fires on mouse clicks.
  const moveTo = (next: number) => {
    onChange(options[next].value);
    btnRefs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveTo((activeIdx + 1) % options.length);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveTo((activeIdx - 1 + options.length) % options.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveTo(options.length - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 3,
        background: 'var(--glass-bg)',
        border: '1px solid var(--panel-bd)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      {options.map((o, i) => {
        const on = i === activeIdx;
        return (
          <button
            key={o.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            style={{
              padding: '7px 14px',
              minHeight: 34,
              borderRadius: 'var(--r-xs)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 'var(--fw-medium)',
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: on ? 'var(--grad-accent)' : 'transparent',
              color: on ? 'var(--ink)' : 'var(--muted)',
              transition: 'color 0.15s ease, background 0.15s ease',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
