import { describe, expect, it } from 'vitest';

import { isoMidnight } from './date';

describe('isoMidnight', () => {
  it('converts YYYY-MM-DD to an ISO UTC-midnight instant', () => {
    expect(isoMidnight('2026-06-30')).toBe('2026-06-30T00:00:00.000Z');
  });
  it('passes non-date strings through unchanged', () => {
    expect(isoMidnight('')).toBe('');
    expect(isoMidnight('whatever')).toBe('whatever');
  });
});
