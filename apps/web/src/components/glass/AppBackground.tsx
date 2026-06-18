import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { EASE } from '../../lib/motion/tokens';
import { Z } from '../../lib/zIndex';

/**
 * Ambient aurora background: three warm blurred radial gradients that drift on
 * their own and react to the pointer (parallax + a cursor spotlight). This is a
 * web "aurora / mesh-gradient" approximation behind the Liquid-Glass chrome, not
 * an official Apple material. ALL ambient motion (autonomous drift, pointer
 * parallax, and the cursor spotlight) is gated on `prefers-reduced-motion:
 * no-preference`, so nothing moves when the user asks to reduce motion.
 */
const BLOBS = [
  { key: 'b1', size: 460, css: { left: '-8%', top: '-14%' }, color: 'var(--b1)', depth: 0.05, idle: [34, -22, 9] },
  { key: 'b2', size: 380, css: { right: '-6%', top: '6%' }, color: 'var(--b2)', depth: -0.04, idle: [-26, 24, 11] },
  { key: 'b3', size: 420, css: { left: '34%', top: '46%' }, color: 'var(--b3)', depth: 0.035, idle: [20, 28, 8] },
] as const;

export function AppBackground({ grid = false }: { grid?: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const blobs = BLOBS.map((b) => el.querySelector<HTMLElement>(`[data-blob="${b.key}"]`));
      const spot = el.querySelector<HTMLElement>('[data-spot]');

      // All ambient motion (idle drift, pointer parallax, cursor spotlight) is
      // user-irrelevant decoration — gate the entire branch on no-preference so
      // nothing moves under reduced-motion.
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        BLOBS.forEach((b, i) => {
          const inner = blobs[i]?.firstElementChild;
          if (inner) {
            gsap.to(inner, { x: b.idle[0], y: b.idle[1], duration: b.idle[2], ease: 'sine.inOut', yoyo: true, repeat: -1 });
          }
        });

        const qx = blobs.map((b) => (b ? gsap.quickTo(b, 'x', { duration: 1.1, ease: EASE.out }) : null));
        const qy = blobs.map((b) => (b ? gsap.quickTo(b, 'y', { duration: 1.1, ease: EASE.out }) : null));
        const sx = spot ? gsap.quickTo(spot, 'x', { duration: 0.6, ease: EASE.out }) : null;
        const sy = spot ? gsap.quickTo(spot, 'y', { duration: 0.6, ease: EASE.out }) : null;

        const onMove = (e: PointerEvent) => {
          if (spot) gsap.to(spot, { opacity: 1, duration: 0.4 });
          sx?.(e.clientX - 260);
          sy?.(e.clientY - 260);
          const dx = e.clientX - window.innerWidth / 2;
          const dy = e.clientY - window.innerHeight / 2;
          BLOBS.forEach((b, i) => {
            qx[i]?.(dx * b.depth);
            qy[i]?.(dy * b.depth);
          });
        };
        document.addEventListener('pointermove', onMove);
        return () => document.removeEventListener('pointermove', onMove);
      });
    },
    { scope: root, dependencies: [] },
  );

  return (
    <div ref={root} aria-hidden="true" style={{ position: 'fixed', inset: 0, overflow: 'hidden', zIndex: Z.background, pointerEvents: 'none' }}>
      {grid && <div className="bg-grid" />}
      {BLOBS.map((b) => (
        <div key={b.key} data-blob={b.key} style={{ position: 'absolute', width: b.size, height: b.size, willChange: 'transform', ...b.css }}>
          <div style={{ width: '100%', height: '100%', borderRadius: '50%', filter: 'blur(var(--blur))', background: `radial-gradient(circle, ${b.color}, transparent 70%)` }} />
        </div>
      ))}
      <div
        data-spot
        style={{
          position: 'absolute',
          width: 520,
          height: 520,
          left: 0,
          top: 0,
          opacity: 0,
          willChange: 'transform',
          borderRadius: '50%',
          filter: 'blur(36px)',
          background: 'radial-gradient(circle, var(--spot), transparent 65%)',
        }}
      />
    </div>
  );
}
