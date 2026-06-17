import type { KeyboardEvent } from 'react';

import { useReducedMotion } from '../../lib/motion/useReducedMotion';

export interface Segment {
  value: string;
  label: string;
}

/**
 * A radiogroup of pill buttons with a sliding active indicator. On the unified
 * contract: `onChange(value)`. Keyboard: arrow keys move (and wrap) the
 * selection; the active option is the only roving tab stop. Warm `--accent`
 * fill, never blue. Reduced motion disables the slide.
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
  const reduced = useReducedMotion();
  const activeIdx = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );

  const move = (dir: 1 | -1) => {
    const next = (activeIdx + dir + options.length) % options.length;
    onChange(options[next].value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(options[0].value);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(options[options.length - 1].value);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="panel"
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `repeat(${String(options.length)}, 1fr)`,
        gap: 4,
        padding: 4,
        borderRadius: 'var(--r-pill)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 4,
          bottom: 4,
          left: 4,
          width: `calc((100% - 8px - ${String((options.length - 1) * 4)}px) / ${String(options.length)})`,
          borderRadius: 'var(--r-pill)',
          background: 'var(--grad-accent)',
          boxShadow: 'var(--shadow-cta)',
          transform: `translateX(calc(${String(activeIdx)} * (100% + 4px)))`,
          transition: reduced ? 'none' : `transform var(--dur-base) var(--ease-out)`,
        }}
      />
      {options.map((o, i) => {
        const on = i === activeIdx;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            style={{
              position: 'relative',
              zIndex: 1,
              padding: '8px 0',
              borderRadius: 'var(--r-pill)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 600,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              color: on ? 'var(--ink)' : 'var(--muted)',
              transition: reduced ? 'none' : `color var(--dur-fast) var(--ease-out)`,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
