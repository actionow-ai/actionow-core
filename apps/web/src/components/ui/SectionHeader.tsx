import type { ReactNode } from 'react';

export function SectionHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
      <h2
        style={{
          fontSize: 'var(--fs-base)',
          fontWeight: 'var(--fw-semibold)',
          letterSpacing: 'var(--track-snug)',
          margin: 0,
          // Truncate a long title instead of pushing the action off the row.
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </h2>
      {action}
    </div>
  );
}
