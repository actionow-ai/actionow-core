import { describe, expect, it } from 'vitest';

import { errorViewSchema } from './error-view.js';

describe('errorViewSchema (the uniform §4.7 error envelope)', () => {
  it('accepts the unified error body and rejects a missing code/message', () => {
    const v = { error: { code: 'invalid_input', message: 'bad name', retryable: false } };
    expect(errorViewSchema.parse(v)).toEqual(v);
    // retry_after_ms is optional (set on rate_limited / retryable upstream errors).
    expect(
      errorViewSchema.parse({
        error: {
          code: 'rate_limited',
          message: 'slow down',
          retryable: true,
          retry_after_ms: 1000,
        },
      }),
    ).toBeTruthy();
    expect(() => errorViewSchema.parse({ error: { message: 'x', retryable: false } })).toThrow();
    expect(() => errorViewSchema.parse({ error: { code: 'x', retryable: false } })).toThrow();
    expect(() => errorViewSchema.parse({})).toThrow();
  });
});
