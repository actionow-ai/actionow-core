import type { ReactNode } from 'react';

import { compareMicroDesc } from '../../lib/money';

/**
 * A generalized horizontal-bar chart for a dimensional breakdown (group-by
 * model / tenant / channel / api_key). Unlike the cost-specific `RankingBar`,
 * it takes any integer µ-metric and a `format` renderer, sorts descending via
 * BigInt, and scales each bar against the largest |value|. Negative values
 * (e.g. margin) render in the `--fail` tone; the bar width is |value| ratio.
 * The ONLY `Number()` is the width %, taken after BigInt division.
 */
export interface MetricBar {
  label: string;
  micro: string;
}

const absBig = (v: bigint): bigint => (v < 0n ? -v : v);

export function MetricBarChart({
  bars,
  format,
  topN = 10,
}: {
  bars: MetricBar[];
  format: (micro: string) => ReactNode;
  topN?: number;
}) {
  const top = [...bars].sort((a, b) => compareMicroDesc(a.micro, b.micro)).slice(0, topN);
  const maxAbs = top.reduce((m, b) => {
    const a = absBig(BigInt(b.micro));
    return a > m ? a : m;
  }, 0n);

  return (
    <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      {top.map((b) => {
        const v = BigInt(b.micro);
        const pct = maxAbs > 0n ? Number((absBig(v) * 1000n) / maxAbs) / 10 : 0;
        const negative = v < 0n;
        return (
          <div
            role="listitem"
            key={b.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--s-3)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            <span
              style={{
                flex: '0 0 30%',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {b.label}
            </span>
            <div
              aria-hidden="true"
              style={{
                flex: 1,
                height: 8,
                borderRadius: 'var(--r-pill)',
                background: 'var(--panel-bd)',
                overflow: 'hidden',
              }}
            >
              <div
                data-bar-fill=""
                style={{
                  width: `${String(pct)}%`,
                  height: '100%',
                  background: negative ? 'var(--fail)' : 'var(--grad-accent)',
                }}
              />
            </div>
            <span
              className="tabular"
              style={{ flexShrink: 0, color: negative ? 'var(--fail)' : undefined }}
            >
              {format(b.micro)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
