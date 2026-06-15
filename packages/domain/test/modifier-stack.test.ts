import type { Modifier } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { applyModifiers } from '../src/pricing/modifier-stack.js';

const mk = (p: Partial<Modifier> & Pick<Modifier, 'id' | 'op' | 'priority'>): Modifier => ({
  scope: 'global',
  stackable: true,
  version: 1,
  value: 0,
  ...p,
});

describe('applyModifiers', () => {
  it('applies in priority order: volume then publisher markup', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'pub', op: 'percent_add', value: 20, priority: 3 }),
      mk({ id: 'vol', op: 'percent_off', value: 10, priority: 1 }),
    ]);
    // 1_000_000 *0.9 = 900_000 ; *1.2 = 1_080_000
    expect(r.final).toBe(1_080_000n);
    expect(r.applied.map((a) => a.id)).toEqual(['vol', 'pub']);
  });
  it('override_rate replaces the base', () => {
    expect(
      applyModifiers(5_000_000n, [
        mk({ id: 'c', op: 'override_rate', value: 2_000_000, priority: 0 }),
      ]).final,
    ).toBe(2_000_000n);
  });
  it('same priority takes the most favorable to buyer', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'p15', op: 'percent_off', value: 15, priority: 2 }),
      mk({ id: 'p10', op: 'percent_off', value: 10, priority: 2 }),
    ]);
    expect(r.final).toBe(850_000n);
    expect(r.applied.map((a) => a.id)).toEqual(['p15']);
  });
  it('flat_off never goes below zero', () => {
    expect(
      applyModifiers(100n, [mk({ id: 'f', op: 'flat_off', value: 999, priority: 2 })]).final,
    ).toBe(0n);
  });
});

describe('applyModifiers — exhaustive', () => {
  it('returns the base unchanged for an empty modifier list', () => {
    const r = applyModifiers(1_000_000n, []);
    expect(r.final).toBe(1_000_000n);
    expect(r.applied).toEqual([]);
  });

  it('records a full audit trail with before/after/version per applied step', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'vol', op: 'percent_off', value: 10, priority: 1, version: 3 }),
      mk({ id: 'pub', op: 'percent_add', value: 20, priority: 3, version: 7 }),
    ]);
    expect(r.applied).toEqual([
      { id: 'vol', version: 3, before: 1_000_000n, after: 900_000n },
      { id: 'pub', version: 7, before: 900_000n, after: 1_080_000n },
    ]);
  });

  it('applies an override mid-stack then continues with later priorities', () => {
    const r = applyModifiers(5_000_000n, [
      mk({ id: 'vol', op: 'percent_off', value: 50, priority: 1 }),
      mk({ id: 'over', op: 'override_rate', value: 2_000_000, priority: 2 }),
      mk({ id: 'pub', op: 'percent_add', value: 10, priority: 3 }),
    ]);
    // 5_000_000 -> *0.5 = 2_500_000 -> override 2_000_000 -> *1.1 = 2_200_000
    expect(r.final).toBe(2_200_000n);
    expect(r.applied.map((a) => a.id)).toEqual(['vol', 'over', 'pub']);
  });

  it('mixes ops across priorities (flat_off then percent)', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'flat', op: 'flat_off', value: 100_000, priority: 1 }),
      mk({ id: 'add', op: 'percent_add', value: 25, priority: 2 }),
    ]);
    // 1_000_000 - 100_000 = 900_000 -> *1.25 = 1_125_000
    expect(r.final).toBe(1_125_000n);
  });

  it('within a same-priority group, picks lowest result regardless of op kind', () => {
    const r = applyModifiers(1_000_000n, [
      mk({ id: 'off50k', op: 'flat_off', value: 50_000, priority: 2 }), // -> 950_000
      mk({ id: 'off20pct', op: 'percent_off', value: 20, priority: 2 }), // -> 800_000 (most favorable)
      mk({ id: 'add10', op: 'percent_add', value: 10, priority: 2 }), // -> 1_100_000
    ]);
    expect(r.final).toBe(800_000n);
    expect(r.applied.map((a) => a.id)).toEqual(['off20pct']);
  });

  it('clamps the running value at zero even across multiple steps', () => {
    const r = applyModifiers(100n, [
      mk({ id: 'f', op: 'flat_off', value: 999, priority: 1 }), // -> 0
      mk({ id: 'p', op: 'percent_add', value: 50, priority: 2 }), // 0 -> 0
    ]);
    expect(r.final).toBe(0n);
  });

  it('throws invalid_pricing when an applicable modifier has no value', () => {
    const bad: Modifier = {
      id: 'x',
      scope: 'global',
      op: 'percent_off',
      stackable: true,
      priority: 1,
      version: 1,
    };
    expect(() => applyModifiers(1_000_000n, [bad])).toThrow(/invalid_pricing/);
  });
});
