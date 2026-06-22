/**
 * The selectable analytics metric and the helper that projects one usage-rollup
 * row onto its integer µ-string for that metric. Shared by the operator overview
 * (`OverviewPage`) and the tenant usage view (`AppUsage`) so both speak the same
 * metric vocabulary. Money metrics are µ-strings (BigInt-safe); counts are plain
 * integers stringified. `margin` is operator-only (the tenant rollup omits it →
 * `'0'`); `errors` lets the chart plot failure volume.
 */
export type Metric = 'cost' | 'margin' | 'requests' | 'tokens' | 'errors';

/** The shape `metricMicro` reads — satisfied by both the admin and tenant rollups. */
export interface MetricRow {
  cost: string;
  requests: number;
  input_tokens: string;
  output_tokens: string;
  /** Operator-only; absent on the tenant rollup. */
  margin?: string;
  errors?: number;
}

/** The integer µ-string for `metric` of one rollup row (never a float). */
export function metricMicro(r: MetricRow, metric: Metric): string {
  switch (metric) {
    case 'cost':
      return r.cost;
    case 'margin':
      return r.margin ?? '0';
    case 'requests':
      return String(r.requests);
    case 'tokens':
      return (BigInt(r.input_tokens) + BigInt(r.output_tokens)).toString();
    case 'errors':
      return String(r.errors ?? 0);
  }
}
