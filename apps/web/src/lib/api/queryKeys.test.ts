import { describe, expect, it } from 'vitest';

import { qk } from './queryKeys';

describe('queryKeys factory', () => {
  it('builds the expected key arrays', () => {
    expect(qk.resources()).toEqual(['admin', 'resources']);
    expect(qk.tenants()).toEqual(['admin', 'tenants']);
    expect(qk.apiKeys('t1')).toEqual(['admin', 'api-keys', 't1']);
    expect(qk.channels('r1')).toEqual(['admin', 'resources', 'r1', 'channels']);
    expect(qk.pricebook('r1')).toEqual(['admin', 'pricebook', 'r1']);
    expect(qk.jobs('t1')).toEqual(['admin', 'jobs', 't1']);
    expect(qk.modifiers()).toEqual(['admin', 'modifiers']);
  });

  it('produces stable (deep-equal) keys for the same input', () => {
    expect(qk.resources()).toEqual(qk.resources());
    expect(qk.apiKeys('t1')).toEqual(qk.apiKeys('t1'));
    expect(qk.channels('r1')).not.toEqual(qk.channels('r2'));
  });

  it('embeds param objects for parametric usage/analytics keys', () => {
    expect(qk.usage({ limit: 10 })).toEqual(['admin', 'usage', { limit: 10 }]);
    expect(qk.analyticsUsage({ groupBy: 'day' })).toEqual([
      'admin',
      'analytics-usage',
      { groupBy: 'day' },
    ]);
  });
});
