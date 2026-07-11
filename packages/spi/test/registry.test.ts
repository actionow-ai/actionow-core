// DialectRegistry: exact (ref, version) addressing — no implicit latest (§6
// 热更新一致性), duplicate registration refused, versions coexist.
import { describe, expect, it } from 'vitest';

import { DialectRegistry } from '../src/index.js';
import { stubDialect } from './stub.js';

describe('DialectRegistry', () => {
  it('resolves by EXACT ref+version and returns undefined otherwise (no implicit latest)', () => {
    const registry = new DialectRegistry();
    const v1 = stubDialect({ ref: 'volc', version: '1.0.0' });
    registry.register(v1);

    expect(registry.resolve({ ref: 'volc', version: '1.0.0' })).toBe(v1);
    expect(registry.resolve({ ref: 'volc', version: '1.0.1' })).toBeUndefined();
    expect(registry.resolve({ ref: 'volc', version: 'latest' })).toBeUndefined();
    expect(registry.resolve({ ref: 'kling', version: '1.0.0' })).toBeUndefined();
  });

  it('lets multiple versions of one ref coexist (per-offering canary)', () => {
    const registry = new DialectRegistry();
    const v1 = stubDialect({ ref: 'volc', version: '1.0.0' });
    const v2 = stubDialect({ ref: 'volc', version: '2.0.0' });
    registry.register(v1);
    registry.register(v2);

    expect(registry.resolve({ ref: 'volc', version: '1.0.0' })).toBe(v1);
    expect(registry.resolve({ ref: 'volc', version: '2.0.0' })).toBe(v2);
    expect(registry.list()).toEqual([v1, v2]);
  });

  it('throws on duplicate (ref, version) — published versions are immutable', () => {
    const registry = new DialectRegistry();
    registry.register(stubDialect({ ref: 'volc', version: '1.0.0' }));
    expect(() => {
      registry.register(stubDialect({ ref: 'volc', version: '1.0.0' }));
    }).toThrow(/already registered: volc@1\.0\.0/);
  });
});
