import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MetricBarChart } from './MetricBarChart';

describe('MetricBarChart', () => {
  it('sorts bars descending by value (largest first) and caps to topN', () => {
    render(
      <MetricBarChart
        bars={[
          { label: 'a', micro: '1000000' },
          { label: 'b', micro: '5000000' },
          { label: 'c', micro: '3000000' },
        ]}
        format={(m) => <span>{m}</span>}
        topN={2}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2); // topN
    expect(items[0]).toHaveTextContent('b'); // 5M largest first
    expect(items[1]).toHaveTextContent('c'); // 3M second; 'a' (1M) dropped
    expect(screen.queryByText('a')).not.toBeInTheDocument();
  });

  it('renders the largest bar at 100% width via BigInt ratio', () => {
    const { container } = render(
      <MetricBarChart
        bars={[
          { label: 'a', micro: '2000000' },
          { label: 'b', micro: '4000000' },
        ]}
        format={(m) => <span>{m}</span>}
      />,
    );
    // The fill bars carry an inline width %. The top bar (4M) should be 100%.
    const fills = [...container.querySelectorAll('[data-bar-fill]')];
    expect(fills[0]?.getAttribute('style')).toContain('width: 100%');
    expect(fills[1]?.getAttribute('style')).toContain('width: 50%'); // 2M / 4M
  });
});
