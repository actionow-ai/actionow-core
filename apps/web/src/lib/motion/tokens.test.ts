import { describe, expect, it } from 'vitest';

import { DUR, EASE } from './tokens';

describe('motion tokens', () => {
  it('exposes numeric second-based durations', () => {
    expect(DUR.base).toBeCloseTo(0.26);
    expect(DUR.slow).toBeGreaterThan(DUR.fast);
  });
  it('exposes gsap-compatible easing strings', () => {
    expect(EASE.out).toMatch(/^cubic-bezier|power|sine|elastic/);
  });
});
