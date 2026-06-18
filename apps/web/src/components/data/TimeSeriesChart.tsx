/**
 * A money-safe SVG time-series chart — the "real" chart primitive (the one
 * `RankingBar` deliberately isn't). Each point's value is an INTEGER µ-string
 * (µUSD cost/margin, token counts, or a plain integer like requests). The Y
 * scale spans a 0-anchored range [min(0,…), max(0,…)] so a 0 baseline always
 * shows and negative series (e.g. margin) dip below it. The ONLY `Number()` is
 * the geometry fraction, taken AFTER BigInt division — values never touch a
 * float. Stroke uses `vector-effect:non-scaling-stroke` so the line stays even
 * under the non-uniform viewBox stretch.
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
}: {
  points: SeriesPoint[];
  height?: number;
  ariaLabel?: string;
}) {
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

  return (
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
    </svg>
  );
}
