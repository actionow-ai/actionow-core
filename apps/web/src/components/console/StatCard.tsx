import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { EASE } from '../../lib/motion/tokens';

export function StatCard({ label, value }: { label: string; value: number | string }) {
  const numRef = useRef<HTMLDivElement>(null);
  const isNumber = typeof value === 'number';

  // Count-up the numeric value 0 → target on mount / value change. Writes
  // textContent directly (no per-frame re-render). Reduced-motion shows the
  // final value immediately. Non-numeric values render as-is (no animation).
  useGSAP(
    () => {
      const el = numRef.current;
      if (!el || !isNumber) return;
      const target = value;
      const dec = target % 1 !== 0;
      const render = (n: number) => (dec ? n.toFixed(1) : Math.round(n).toLocaleString());

      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        el.textContent = render(0); // avoid a one-frame flash of the final value
        const o = { v: 0 };
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
    },
    { scope: numRef, dependencies: [value, isNumber] },
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
