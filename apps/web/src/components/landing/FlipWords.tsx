import type { CSSProperties } from 'react';
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';

/**
 * Kinetic headline word that flips through `words` (Aceternity "Flip Words",
 * GSAP-driven). Autonomous, so it stops under prefers-reduced-motion (shows the
 * first word). Drives textContent directly to avoid re-rendering the tree.
 */
export function FlipWords({ words, className, style }: { words: string[]; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      const el = ref.current;
      if (!el || words.length === 0) return;
      el.textContent = words[0];
      if (reduced || words.length < 2) return;

      let idx = 0;
      const tl = gsap.timeline({ repeat: -1 });
      words.forEach(() => {
        tl.to(el, {
          delay: 1.8,
          duration: 0.36,
          yPercent: -45,
          opacity: 0,
          ease: 'power2.in',
          onComplete: () => {
            idx = (idx + 1) % words.length;
            el.textContent = words[idx];
          },
        }).fromTo(
          el,
          { yPercent: 45, opacity: 0 },
          { yPercent: 0, opacity: 1, duration: 0.42, ease: 'power3.out' },
        );
      });
    },
    { scope: ref, dependencies: [reduced, words.join('|')] },
  );

  return <span ref={ref} className={className} style={{ display: 'inline-block', ...style }} />;
}
