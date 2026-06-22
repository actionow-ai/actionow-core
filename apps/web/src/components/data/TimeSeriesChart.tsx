import { useState } from 'react';

/**
 * A money-safe SVG time-series chart — the "real" chart primitive (the one
 * `RankingBar` deliberately isn't). Each point's value is an INTEGER µ-string
 * (µUSD cost/margin, token counts, or a plain integer like requests). The Y
 * scale spans a 0-anchored range [min(0,…), max(0,…)] so a 0 baseline always
 * shows and negative series (e.g. margin) dip below it. The ONLY `Number()` is
 * the geometry fraction, taken AFTER BigInt division — values never touch a
 * float. Stroke uses `vector-effect:non-scaling-stroke` so the line stays even
 * under the non-uniform viewBox stretch.
 *
 * Hovering a point shows a tooltip rendered in an `overflow:visible` overlay
 * positioned OUTSIDE the SVG flow, so a host panel's padding/rounding can never
 * clip it (the reported "tooltip occluded" issue).
 */
export interface SeriesPoint {
  label: string;
  /** Integer µ-string (µUSD, tokens, or a plain integer as a string). */
  micro: string;
}

const VW = 600; // viewBox width (stretched to container); height is real px.
const PAD_X = 6;

export function TimeSeriesChart({
  points,
  height = 180,
  ariaLabel,
  format,
}: {
  points: SeriesPoint[];
  height?: number;
  ariaLabel?: string;
  /** Render the tooltip value from its µ-string (defaults to the raw string). */
  format?: (micro: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const padY = 12;
  const plotH = height - padY * 2;
  const values = points.map((p) => BigInt(p.micro));
  // Anchor the range at 0 so the baseline is meaningful and negatives dip below.
  const lo = values.reduce((m, v) => (v < m ? v : m), 0n);
  const hi = values.reduce((m, v) => (v > m ? v : m), 0n);
  const range = hi - lo;

  // frac in [0,1] of where `v` sits within [lo,hi]; 0 → bottom, 1 → top.
  const yFor = (v: bigint): number => {
    const frac = range > 0n ? Number(((v - lo) * 100000n) / range) / 100000 : 0;
    return padY + (1 - frac) * plotH;
  };
  const xFor = (i: number): number =>
    points.length === 1 ? VW / 2 : PAD_X + (i / (points.length - 1)) * (VW - PAD_X * 2);

  const baseline = yFor(0n);
  const pt = (i: number, v: bigint): string => `${String(xFor(i))},${String(yFor(v))}`;
  const linePts = points.map((p, i) => pt(i, BigInt(p.micro))).join(' ');
  // Area = the line, then down to the baseline and back to the start.
  const area = `M ${String(xFor(0))},${String(baseline)} L ${points
    .map((p, i) => pt(i, BigInt(p.micro)))
    .join(' L ')} L ${String(xFor(points.length - 1))},${String(baseline)} Z`;

  const hovered = hover === null ? undefined : points[hover];

  return (
    <div style={{ position: 'relative', overflow: 'visible' }}>
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${String(VW)} ${String(height)}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        style={{ display: 'block', overflow: 'visible' }}
      >
        <path d={area} fill="var(--accent)" fillOpacity={0.12} stroke="none" />
        <line
          data-baseline=""
          x1={0}
          x2={VW}
          y1={baseline}
          y2={baseline}
          stroke="var(--panel-bd)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={linePts}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* The hovered vertex gets a visible marker; a lone point always shows one
            (a 1-vertex polyline draws nothing). */}
        {points.map((p, i) =>
          hover === i || (points.length === 1 && i === 0) ? (
            <circle
              key={`dot-${String(i)}`}
              cx={xFor(i)}
              cy={yFor(BigInt(p.micro))}
              r={4}
              fill="var(--accent)"
              stroke="none"
            />
          ) : null,
        )}
        {/* Invisible full-height hit columns drive the hover (one per point). */}
        {points.map((_p, i) => {
          const w = points.length === 1 ? VW : (VW - PAD_X * 2) / points.length;
          return (
            <rect
              key={`hit-${String(i)}`}
              x={xFor(i) - w / 2}
              y={0}
              width={w}
              height={height}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      {hovered !== undefined && hover !== null && (
        <div
          style={{
            position: 'absolute',
            left: `${String((xFor(hover) / VW) * 100)}%`,
            top: `${String((yFor(BigInt(hovered.micro)) / height) * 100)}%`,
            transform: 'translate(-50%, calc(-100% - 8px))',
            pointerEvents: 'none',
            background: 'var(--surface-strong, rgba(20,20,20,.92))',
            color: 'var(--on-strong, #fff)',
            border: '1px solid var(--panel-bd)',
            borderRadius: 'var(--r-sm)',
            padding: '4px 8px',
            fontSize: 'var(--fs-caption)',
            whiteSpace: 'nowrap',
            zIndex: 20,
            boxShadow: 'var(--shadow-lift)',
          }}
        >
          <span style={{ opacity: 0.7 }}>{hovered.label}</span>{' '}
          <span className="tabular" style={{ fontWeight: 'var(--fw-medium)' }}>
            {format ? format(hovered.micro) : hovered.micro}
          </span>
        </div>
      )}
    </div>
  );
}
