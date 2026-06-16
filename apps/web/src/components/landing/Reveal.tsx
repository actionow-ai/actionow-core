import type { CSSProperties, ReactNode } from 'react';
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';

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
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (reduced || !ref.current) return;
      gsap.from(ref.current, {
        opacity: 0,
        y,
        duration: 0.7,
        delay,
        ease: 'power3.out',
        scrollTrigger: { trigger: ref.current, start: 'top 86%', once: true },
      });
    },
    { scope: ref, dependencies: [reduced] },
  );

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
