import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';

import { useReducedMotion } from '../../lib/motion/useReducedMotion';

/**
 * Brand loading mark — a parametric rose curve (r = a·cos 4θ) traced by a fading
 * particle trail, with a slow rotation and a breathing "pulse" that swells the
 * petals. Adapted from the math-curve-loader sketch onto our warm accent palette.
 *
 * Imperative by design: the SVG nodes are written via refs inside one rAF loop
 * (no React re-render per frame). The loop pauses automatically in a hidden tab
 * and is cancelled on unmount. Honors prefers-reduced-motion by drawing the rose
 * statically (no motion), so it still reads as a mark while loading.
 */
const CFG = {
  particleCount: 24,
  trailSpan: 0.32,
  durationMs: 5400,
  rotationDurationMs: 28000,
  pulseDurationMs: 4500,
  strokeWidth: 4.6,
  roseA: 9.2,
  roseABoost: 0.6,
  roseBreathBase: 0.72,
  roseBreathBoost: 0.28,
  roseScale: 3.25,
} as const;

function point(progress: number, detailScale: number): { x: number; y: number } {
  const t = progress * Math.PI * 2;
  const a = CFG.roseA + detailScale * CFG.roseABoost;
  const r = a * (CFG.roseBreathBase + detailScale * CFG.roseBreathBoost) * Math.cos(4 * t);
  return { x: 50 + Math.cos(t) * r * CFG.roseScale, y: 50 + Math.sin(t) * r * CFG.roseScale };
}

function buildPath(detailScale: number, steps = 360): string {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const p = point(i / steps, detailScale);
    d += `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
  }
  return d;
}

const wrap = (n: number): number => ((n % 1) + 1) % 1;

export function RoseLoader({ size = 96, speed = 1, label, style }: { size?: number; speed?: number; label?: string; style?: CSSProperties }) {
  const reduced = useReducedMotion();
  const groupRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const dotsRef = useRef<(SVGCircleElement | null)[]>([]);

  useEffect(() => {
    const path = pathRef.current;
    const group = groupRef.current;
    if (!path) return;

    // Reduced motion: a single static rose, no rAF.
    if (reduced) {
      path.setAttribute('d', buildPath(1));
      path.setAttribute('opacity', '0.85');
      return;
    }

    const dur = CFG.durationMs / speed;
    const rotDur = CFG.rotationDurationMs / speed;
    const pulseDur = CFG.pulseDurationMs / speed;
    const start = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const time = now - start;
      const progress = (time % dur) / dur;
      const pulse = (time % pulseDur) / pulseDur;
      const detailScale = 0.52 + ((Math.sin(pulse * Math.PI * 2 + 0.55) + 1) / 2) * 0.48;

      if (group) group.setAttribute('transform', `rotate(${String(-((time % rotDur) / rotDur) * 360)} 50 50)`);
      path.setAttribute('d', buildPath(detailScale));

      for (let i = 0; i < dotsRef.current.length; i++) {
        const node = dotsRef.current[i];
        if (!node) continue;
        const tail = i / (CFG.particleCount - 1);
        const p = point(wrap(progress - tail * CFG.trailSpan), detailScale);
        const fade = Math.pow(1 - tail, 0.56);
        node.setAttribute('cx', p.x.toFixed(2));
        node.setAttribute('cy', p.y.toFixed(2));
        node.setAttribute('r', (0.9 + fade * 2.7).toFixed(2));
        node.setAttribute('opacity', (0.04 + fade * 0.96).toFixed(3));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced, speed]);

  return (
    <div
      role="status"
      aria-label={label}
      aria-live="polite"
      style={{ width: size, height: size, color: 'var(--accent)', display: 'grid', placeItems: 'center', ...style }}
    >
      <svg
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        fill="none"
        aria-hidden="true"
        style={{ overflow: 'visible', filter: 'drop-shadow(var(--glow-accent))' }}
      >
        <g ref={groupRef}>
          <path
            ref={pathRef}
            stroke="currentColor"
            strokeWidth={CFG.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.12}
          />
          {Array.from({ length: CFG.particleCount }, (_, i) => (
            <circle
              key={i}
              fill="currentColor"
              ref={(el) => {
                dotsRef.current[i] = el;
              }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
