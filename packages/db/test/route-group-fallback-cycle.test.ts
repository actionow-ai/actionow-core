import { describe, expect, it } from 'vitest';

import { checkFallbackChain, FALLBACK_MAX_DEPTH } from '../src/repositories/index.js';

/**
 * Pure unit test for the cross-group fallback cycle/depth guard (弹性2.0). No DB:
 * `checkFallbackChain` walks the proposed chain via a caller-supplied resolver, so
 * the existing `fallback_group_id` graph is a plain map here.
 */
describe('checkFallbackChain (route-group fallback cycle guard)', () => {
  /** Build a resolver over a `{ groupId: currentFallbackId }` adjacency map. */
  function resolver(graph: Record<string, string | null>) {
    return (id: string): Promise<string | null | undefined> => Promise.resolve(graph[id] ?? null);
  }

  it('accepts a fresh target with no onward chain', async () => {
    expect(await checkFallbackChain('a', 'b', resolver({}))).toBeNull();
  });

  it('accepts a target whose own chain stays within depth and never loops back', async () => {
    // a → b → c → d : 4 groups incl. source, within FALLBACK_MAX_DEPTH (5).
    expect(await checkFallbackChain('a', 'b', resolver({ b: 'c', c: 'd' }))).toBeNull();
  });

  it('rejects a direct self-reference (A→A) as a cycle', async () => {
    expect(await checkFallbackChain('a', 'a', resolver({}))).toBe('cycle');
  });

  it('rejects a 2-cycle (A→B where B already → A)', async () => {
    // Existing graph has b → a; proposing a → b closes the loop.
    expect(await checkFallbackChain('a', 'b', resolver({ b: 'a' }))).toBe('cycle');
  });

  it('rejects a deeper cycle (A→B, B→C, C→A)', async () => {
    expect(await checkFallbackChain('a', 'b', resolver({ b: 'c', c: 'a' }))).toBe('cycle');
  });

  it('rejects a chain that would exceed FALLBACK_MAX_DEPTH', async () => {
    // a(1) → b(2) → c(3) → d(4) → e(5) → f(6): 6 groups > MAX (5) → too-deep.
    expect(await checkFallbackChain('a', 'b', resolver({ b: 'c', c: 'd', d: 'e', e: 'f' }))).toBe(
      'too-deep',
    );
  });

  it('accepts a chain exactly at FALLBACK_MAX_DEPTH', async () => {
    // a(1) → b(2) → c(3) → d(4) → e(5): exactly 5 groups → ok.
    expect(FALLBACK_MAX_DEPTH).toBe(5);
    expect(await checkFallbackChain('a', 'b', resolver({ b: 'c', c: 'd', d: 'e' }))).toBeNull();
  });
});
