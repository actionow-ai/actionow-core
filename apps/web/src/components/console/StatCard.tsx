import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { EASE } from '../../lib/motion/tokens';

export function StatCard({ label, value }: { label: string; value: number | string }) {
  const numRef = useRef<HTMLDivElement>(null);
  const isNumber = typeof value === 'number';
  // Last numeric value we counted to, so a live refetch animates from where the
  // display already sits instead of snapping back to 0.
  const fromRef = useRef(0);

  // Count-up the numeric value → target on mount / value change. Writes
  // textContent directly (no per-frame re-render). Reduced-motion shows the
  // final value immediately. Non-numeric values render as-is (no animation).
  // revertOnUpdate kills the prior tween before the next one so two tweens can't
  // write textContent at once (flicker) when `value` changes mid-animation.
  useGSAP(
    () => {
      const el = numRef.current;
      if (!el || !isNumber) return;
      const target = value;
      const start = fromRef.current;
      const dec = target % 1 !== 0 || start % 1 !== 0;
      const render = (n: number) => (dec ? n.toFixed(1) : Math.round(n).toLocaleString());

      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        el.textContent = render(start); // avoid a one-frame flash of the final value
        const o = { v: start };
        gsap.to(o, {
          v: target,
          duration: 1.4,
          ease: EASE.out,
          onUpdate: () => {
            el.textContent = render(o.v);
          },
        });
      });
      mm.add('(prefers-reduced-motion: reduce)', () => {
        el.textContent = render(target);
      });
      fromRef.current = target;
    },
    { scope: numRef, dependencies: [value, isNumber], revertOnUpdate: true },
  );

  return (
    <div className="glass" style={{ padding: 'var(--s-5)', borderRadius: 'var(--r-md)' }}>
      <div style={{ fontSize: 'var(--fs-nano)', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)' }}>{label}</div>
      <div ref={numRef} className="tabular" style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, marginTop: 8, letterSpacing: '-.02em' }}>
        {value}
      </div>
    </div>
  );
}
