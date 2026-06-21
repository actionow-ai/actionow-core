import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { UsageRollupView } from '../../lib/api/types';
import { RankingBar } from './RankingBar';

function row(bucket: string, cost: string, margin = '0'): UsageRollupView {
  return {
    bucket,
    requests: 1,
    input_tokens: '0',
    output_tokens: '0',
    cost,
    provider_cost: '0',
    margin,
    errors: 0,
  };
}

describe('RankingBar', () => {
  it('renders only the top-N rows, highest cost first', () => {
    const rows = [
      row('e', '5000000'),
      row('a', '9000000'),
      row('c', '7000000'),
      row('f', '1000000'),
      row('b', '8000000'),
      row('d', '6000000'),
    ];
    render(<RankingBar rows={rows} topN={3} />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('a'); // 9M
    expect(items[1]).toHaveTextContent('b'); // 8M
    expect(items[2]).toHaveTextContent('c'); // 7M
  });
});
