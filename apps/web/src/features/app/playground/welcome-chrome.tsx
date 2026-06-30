import type { ReactNode } from 'react';

/** Full-height centered column for playground welcome / placeholder screens. */
export function Center({ children }: { children: ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 'var(--s-5)' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--s-3)',
          textAlign: 'center',
          maxWidth: 560,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A 56px icon badge — accent gradient (primary) or glass (secondary). */
export function Badge({ icon, accent }: { icon: ReactNode; accent?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 56,
        height: 56,
        borderRadius: 'var(--r-lg)',
        display: 'grid',
        placeItems: 'center',
        background: accent === true ? 'var(--grad-accent)' : 'var(--glass-bg)',
        border: accent === true ? 'none' : '1px solid var(--panel-bd)',
        color: accent === true ? 'var(--bg)' : 'var(--muted)',
        boxShadow: accent === true ? 'var(--shadow-lift)' : 'none',
      }}
    >
      {icon}
    </span>
  );
}
