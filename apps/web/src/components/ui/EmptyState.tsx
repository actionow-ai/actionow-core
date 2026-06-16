import type { ReactNode } from 'react';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 'var(--s-8)', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{children}</div>
  );
}
