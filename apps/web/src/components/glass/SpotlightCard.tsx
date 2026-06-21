import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { useRef } from 'react';

/**
 * Glass card with a cursor-following warm radial glow (Aceternity "Card
 * Spotlight"). Pointer-driven via CSS custom props, so it needs no autonomous
 * animation and works fine under reduced motion.
 */
export function SpotlightCard({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${String(e.clientX - r.left)}px`);
    el.style.setProperty('--my', `${String(e.clientY - r.top)}px`);
  };
  return (
    <div ref={ref} onPointerMove={onMove} className={`spotlight-card glass glass-hover ${className}`} style={style}>
      <span className="spotlight-glow" aria-hidden="true" />
      <div style={{ position: 'relative', zIndex: 1, height: '100%' }}>{children}</div>
    </div>
  );
}
