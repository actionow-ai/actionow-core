import type { ReactNode } from 'react';

export function SectionHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', margin: 0, whiteSpace: 'nowrap' }}>
        {title}
      </h2>
      {action}
    </div>
  );
}
