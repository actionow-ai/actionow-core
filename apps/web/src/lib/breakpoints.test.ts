import { describe, expect, it } from 'vitest';

import { BP } from './breakpoints';

describe('breakpoints', () => {
  it('defines the canonical media queries', () => {
    expect(BP.md).toBe('(min-width: 768px)');
    expect(BP.lg).toBe('(min-width: 960px)');
    expect(BP.xl).toBe('(min-width: 1100px)');
  });
});
