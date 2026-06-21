import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TimeSeriesChart } from './TimeSeriesChart';

/** Parse the y-coordinate of each vertex from the line polyline's `points`. */
function vertexYs(container: HTMLElement): number[] {
  const pl = container.querySelector('polyline');
  return (pl?.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pt) => Number(pt.split(',')[1]));
}

describe('TimeSeriesChart scaling', () => {
  it('maps the peak value to the smallest y (top) and the min to the largest y (bottom)', () => {
    const { container } = render(
      <TimeSeriesChart
        points={[
          { label: 'd1', micro: '1000000' }, // min
          { label: 'd2', micro: '3000000' }, // peak
          { label: 'd3', micro: '2000000' },
        ]}
      />,
    );
    const [y0, y1, y2] = vertexYs(container);
    expect(y1).toBeLessThan(y0); // peak (3M) is highest on screen → smallest y
    expect(y1).toBeLessThan(y2);
    expect(y0).toBeGreaterThan(y2); // min (1M) is lowest on screen → largest y
  });

  it('places a negative value below the zero baseline and a positive value above it', () => {
    const { container } = render(
      <TimeSeriesChart
        points={[
          { label: 'a', micro: '-2000000' }, // below 0
          { label: 'b', micro: '4000000' }, // above 0
        ]}
      />,
    );
    const [yNeg, yPos] = vertexYs(container);
    const baseline = Number(container.querySelector('line[data-baseline]')?.getAttribute('y1'));
    expect(yNeg).toBeGreaterThan(baseline); // negative sits below the 0 line
    expect(yPos).toBeLessThan(baseline); // positive sits above it
  });
});
