import type { UsageRollupView } from '../../lib/api/types';
import { compareMicroDesc, formatCreditsSigned } from '../../lib/money';
import { Money } from '../data/Money';

/**
 * A compact "top-N by cost" horizontal-bar board — explicitly NOT the full chart
 * primitive (that comes in the analytics page). Sorts a COPY of `rows` descending
 * by cost via BigInt (`compareMicroDesc`), takes the top N, and draws one labeled
 * bar per bucket with the cost and (optionally) the signed margin. The ONLY
 * `Number()` is the CSS width %, computed AFTER BigInt math and guarded against
 * divide-by-zero — money never passes through a float.
 */
export function RankingBar({
  rows,
  topN = 5,
  showMargin = true,
}: {
  rows: UsageRollupView[];
  topN?: number;
  showMargin?: boolean;
}) {
  const top = [...rows].sort((a, b) => compareMicroDesc(a.cost, b.cost)).slice(0, topN);
  const max = top.reduce((m, r) => {
    const c = BigInt(r.cost);
    return c > m ? c : m;
  }, 0n);

  return (
    <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      {top.map((r) => {
        const pct = max > 0n ? Number((BigInt(r.cost) * 1000n) / max) / 10 : 0;
        const marginNegative = BigInt(r.margin) < 0n;
        return (
          <div
            role="listitem"
            key={r.bucket}
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
              {r.bucket}
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
                style={{
                  width: `${String(pct)}%`,
                  height: '100%',
                  background: 'var(--grad-accent)',
                }}
              />
            </div>
            <span style={{ flexShrink: 0 }}>
              <Money micro={r.cost} />
            </span>
            {showMargin && (
              <span
                className="tabular"
                style={{ flexShrink: 0, color: marginNegative ? 'var(--fail)' : 'var(--ok)' }}
              >
                {formatCreditsSigned(r.margin)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
