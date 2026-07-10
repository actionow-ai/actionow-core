import type { ReactNode } from 'react';

import { Z } from '../../lib/zIndex';

/** Fixed width of a compact toolbar filter control (text/combobox cells). */
export const FILTER_CONTROL_W = 150;
/** Minimum width of a toolbar entity select (e.g. TenantSelect). */
export const FILTER_SELECT_MIN_W = 180;

/**
 * The sticky single-lens filter bar shared by the ops list surfaces
 * (概览·分析 / 中转追踪 / 审计日志): a `.panel` pinned to the top of the shell
 * scroll area, with the page's filter controls wrapping inside it. Extracted so
 * the pages stop copy-pasting the style block (the copies had drifted: an
 * inline `blur(8px)` fighting the `.panel` class's 10px, and a magic z-index).
 */
export function StickyFilterBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="panel"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: Z.sticky,
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-3)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--s-3)',
        alignItems: 'center',
        boxShadow: 'var(--shadow-lift)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Inline-labelled filter cell: a real `<label htmlFor>` to the LEFT of a
 * {@link FILTER_CONTROL_W}-wide control (toolbar-friendly, and the control gets
 * an accessible name — no placeholder-as-label).
 */
export function InlineFilterField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
      <label
        htmlFor={id}
        style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', whiteSpace: 'nowrap' }}
      >
        {label}
      </label>
      <div style={{ width: FILTER_CONTROL_W }}>{children}</div>
    </div>
  );
}

/**
 * Inline caption + control for a filter whose control carries its own
 * `aria-label` (e.g. `DateField` 起/止) — the visible text is presentation only.
 */
export function InlineFilterLabel({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--muted)',
      }}
    >
      {text}
      {children}
    </span>
  );
}
