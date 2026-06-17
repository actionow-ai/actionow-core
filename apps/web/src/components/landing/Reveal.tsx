import type { CSSProperties, ReactNode } from 'react';
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';

/**
 * Scroll-reveal: fades + lifts its children once when they enter the viewport.
 * Motivation: storytelling — sections arrive in reading order. Honors
 * prefers-reduced-motion (content renders statically).
 */
export function Reveal({
  children,
  y = 22,
  delay = 0,
  className,
  style,
}: {
  children: ReactNode;
  y?: number;
  delay?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // fromTo (explicit start+end) so a re-run can't leave content hidden.
        gsap.fromTo(
          el,
          { opacity: 0, y },
          {
            opacity: 1,
            y: 0,
            duration: DUR.slower,
            delay,
            ease: EASE.out,
            scrollTrigger: { trigger: el, start: 'top 86%', once: true },
          },
        );
      });
    },
    { scope: ref, dependencies: [y, delay] },
  );

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
