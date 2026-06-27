import type { CSSProperties } from 'react';
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';

/**
 * Kinetic headline word that flips through `words` (Aceternity "Flip Words",
 * GSAP-driven). Autonomous, so it stops under prefers-reduced-motion (shows the
 * first word). Drives textContent directly to avoid re-rendering the tree.
 */
export function FlipWords({ words, className, style }: { words: string[]; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el || words.length === 0) return;
      // First word is always shown (also the reduced-motion end state).
      el.textContent = words[0] ?? '';
      if (words.length < 2) return;

      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        let idx = 0;
        const tl = gsap.timeline({ repeat: -1 });
        words.forEach(() => {
          tl.to(el, {
            delay: 1.8,
            duration: DUR.base,
            yPercent: -45,
            opacity: 0,
            ease: EASE.in,
            onComplete: () => {
              idx = (idx + 1) % words.length;
              el.textContent = words[idx] ?? '';
            },
          }).fromTo(
            el,
            { yPercent: 45, opacity: 0 },
            // immediateRender:false — without it, every fromTo in the timeline
            // applies its "from" (opacity 0) at build time, blanking the word
            // for the first ~1.8s hold before the playhead reaches it.
            { yPercent: 0, opacity: 1, duration: DUR.slow, ease: EASE.out, immediateRender: false },
          );
        });
      });
    },
    { scope: ref, dependencies: [words.join('|')] },
  );

  return <span ref={ref} className={className} style={{ display: 'inline-block', ...style }} />;
}
