import { describe, expect, it } from 'vitest';

import type { UsageRollupView } from '../../lib/api/types';
import { metricMicro } from './AnalyticsPage';

const row: UsageRollupView = {
  bucket: 'gpt-5-codex',
  requests: 3,
  input_tokens: '117',
  output_tokens: '67',
  cost: '812',
  provider_cost: '500',
  margin: '-200',
  errors: 1,
};

describe('AnalyticsPage metricMicro', () => {
  it('maps each metric to its integer µ-string', () => {
    expect(metricMicro(row, 'cost')).toBe('812');
    expect(metricMicro(row, 'margin')).toBe('-200'); // negative margins survive as-is
    expect(metricMicro(row, 'requests')).toBe('3');
  });

  it('sums input + output tokens via BigInt for the tokens metric', () => {
    expect(metricMicro(row, 'tokens')).toBe('184'); // 117 + 67
  });
});
