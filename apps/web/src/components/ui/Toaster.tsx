import { useEffect, useRef, useState } from 'react';

import { DUR } from '../../lib/motion/tokens';
import { Z } from '../../lib/zIndex';
import type { ToastMsg } from './toast';
import { subscribeToast } from './toast';

interface ToastItem extends ToastMsg {
  /** drives the enter/exit transition: false until removal is scheduled */
  leaving: boolean;
}

const LIFETIME_MS = 3500;
const EXIT_MS = DUR.base * 1000;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return subscribeToast((m) => {
      setItems((xs) => [...xs, { ...m, leaving: false }]);
      // Mark the toast leaving (plays the exit transition), then remove it
      // after the exit duration. Reduced-motion collapses the exit to instant.
      setTimeout(() => {
        setItems((xs) => xs.map((x) => (x.id === m.id ? { ...x, leaving: true } : x)));
        setTimeout(
          () => {
            setItems((xs) => xs.filter((x) => x.id !== m.id));
          },
          reduced.current ? 0 : EXIT_MS,
        );
      }, LIFETIME_MS);
    });
  }, []);

  return (
    // Presentational wrapper — each toast is its own live region (per-tone
    // politeness) to avoid a nested-live-region double announcement.
    <div
      style={{
        position: 'fixed',
        right: 'var(--s-4)',
        bottom: 'var(--s-4)',
        zIndex: Z.toast,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-2)',
      }}
    >
      {items.map((m) => (
        <Toast key={m.id} item={m} />
      ))}
    </div>
  );
}

function Toast({ item }: { item: ToastItem }) {
  // Enter: mount hidden, then flip to shown on the next frame so the CSS
  // transition runs (transform/opacity only). Exit: `leaving` flips it back.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const visible = shown && !item.leaving;
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      aria-live={item.tone === 'error' ? 'assertive' : 'polite'}
      className="glass"
      style={{
        padding: '10px 14px',
        borderRadius: 'var(--r-md)',
        fontSize: 'var(--fs-sm)',
        color: item.tone === 'error' ? 'var(--fail)' : 'var(--text)',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: `opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out)`,
      }}
    >
      {item.text}
    </div>
  );
}
