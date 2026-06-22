import { describe, expect, it } from 'vitest';

import { metricMicro, type MetricRow } from './analyticsMetric';

const row: MetricRow = {
  cost: '812',
  requests: 3,
  input_tokens: '117',
  output_tokens: '67',
  margin: '-200',
  errors: 1,
};

describe('metricMicro', () => {
  it('maps each metric to its integer µ-string', () => {
    expect(metricMicro(row, 'cost')).toBe('812');
    expect(metricMicro(row, 'margin')).toBe('-200'); // negative margins survive as-is
    expect(metricMicro(row, 'requests')).toBe('3');
    expect(metricMicro(row, 'errors')).toBe('1');
  });

  it('sums input + output tokens via BigInt for the tokens metric', () => {
    expect(metricMicro(row, 'tokens')).toBe('184'); // 117 + 67
  });

  it('defaults margin/errors when absent (tenant rollup)', () => {
    const tenant: MetricRow = { cost: '5', requests: 1, input_tokens: '0', output_tokens: '0' };
    expect(metricMicro(tenant, 'margin')).toBe('0');
    expect(metricMicro(tenant, 'errors')).toBe('0');
  });
});
