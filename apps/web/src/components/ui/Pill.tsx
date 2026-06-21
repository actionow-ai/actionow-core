import type { ReactNode } from 'react';

export type PillTone = 'ok' | 'run' | 'wait' | 'fail' | 'idle';

const TONE_COLOR: Record<PillTone, string> = {
  ok: 'var(--ok)',
  run: 'var(--run)',
  wait: 'var(--wait)',
  fail: 'var(--fail)',
  idle: 'var(--idle)',
};

/**
 * A colored status/value pill — the design system's `.pill`: inline-flex, pill
 * radius, a tone-tinted background derived via `color-mix`, and an optional
 * leading status dot. `StatusBadge` and `MockBadge` compose this; pass arbitrary
 * children for value pills like `×1.00` / `Beta`.
 */
export function Pill({
  tone,
  dot = false,
  children,
  title,
}: {
  tone: PillTone;
  /** Render the 6px leading status dot (used by StatusBadge). */
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 'var(--fs-caption)',
        fontWeight: 'var(--fw-medium)',
        padding: '3px 9px',
        borderRadius: 'var(--r-pill)',
        whiteSpace: 'nowrap',
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
      }}
    >
      {dot && (
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
      )}
      {children}
    </span>
  );
}
