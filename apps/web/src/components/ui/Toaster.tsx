import { useEffect, useState } from 'react';

import type { ToastMsg } from './toast';
import { subscribeToast } from './toast';

export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(
    () =>
      subscribeToast((m) => {
        setItems((xs) => [...xs, m]);
        setTimeout(() => {
          setItems((xs) => xs.filter((x) => x.id !== m.id));
        }, 3500);
      }),
    [],
  );
  return (
    <div
      style={{
        position: 'fixed',
        right: 'var(--s-4)',
        bottom: 'var(--s-4)',
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-2)',
      }}
    >
      {items.map((m) => (
        <div
          key={m.id}
          role="status"
          className="glass"
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-sm)',
            color: m.tone === 'error' ? 'var(--fail)' : 'var(--text)',
          }}
        >
          {m.text}
        </div>
      ))}
    </div>
  );
}
