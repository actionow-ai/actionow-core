import { describe, expect, it } from 'vitest';

import { engineForbidden } from '../src/common/errors.js';
import { statusForCode } from '../src/common/unified-error.filter.js';

describe('engineForbidden', () => {
  it('builds a non-retryable forbidden EngineError', () => {
    const err = engineForbidden('tenant admin role required');
    expect(err.unified.code).toBe('forbidden');
    expect(err.unified.message).toBe('tenant admin role required');
    expect(err.unified.retryable).toBe(false);
  });

  it('maps the forbidden code to HTTP 403', () => {
    expect(statusForCode('forbidden')).toBe(403);
  });
});
