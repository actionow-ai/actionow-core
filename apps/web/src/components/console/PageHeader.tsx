import type { ReactNode } from 'react';

/** Console page header: title (+ optional count) on the left, an action on the right. */
export function PageHeader({ title, count, action }: { title: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)', minWidth: 0 }}>
        <h1 style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)', letterSpacing: 'var(--track-snug)', margin: 0, whiteSpace: 'nowrap' }}>
          {title}
        </h1>
        {count !== undefined && (
          <span className="tabular" style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{count}</span>
        )}
      </div>
      {action}
    </div>
  );
}
