import type { UnifiedError, UnifiedErrorCode } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { AdapterError, httpStatusToUnified } from '../src/errors.js';

interface MappingCase {
  status: number;
  code: UnifiedErrorCode;
  retryable: boolean;
}

const cases: MappingCase[] = [
  { status: 400, code: 'invalid_input', retryable: false },
  { status: 401, code: 'unauthorized', retryable: false },
  { status: 403, code: 'unauthorized', retryable: false },
  { status: 404, code: 'resource_not_found', retryable: false },
  { status: 408, code: 'upstream_timeout', retryable: true },
  { status: 429, code: 'rate_limited', retryable: true },
  { status: 500, code: 'upstream_error', retryable: true },
  { status: 502, code: 'upstream_error', retryable: true },
  { status: 503, code: 'upstream_error', retryable: true },
  { status: 599, code: 'upstream_error', retryable: true },
  // Anything not explicitly mapped (and not 5xx) → non-retryable upstream_error.
  { status: 418, code: 'upstream_error', retryable: false },
  { status: 301, code: 'upstream_error', retryable: false },
];

describe('httpStatusToUnified', () => {
  it.each(cases)('maps $status → $code (retryable=$retryable)', ({ status, code, retryable }) => {
    const err = httpStatusToUnified('openai', status);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.upstream).toEqual({ provider: 'openai' });
  });

  it('threads the upstream rawCode through when provided', () => {
    const err = httpStatusToUnified('anthropic', 429, 'rate_limit_exceeded');
    expect(err.upstream).toEqual({ provider: 'anthropic', rawCode: 'rate_limit_exceeded' });
    expect(err.code).toBe('rate_limited');
  });
});

describe('AdapterError', () => {
  it('carries the unified error and exposes a name + message', () => {
    const unified: UnifiedError = {
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
    };
    const err = new AdapterError(unified);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AdapterError');
    expect(err.unified).toBe(unified);
    expect(err.message).toBe('slow down');
  });

  it('is throwable and catchable as an AdapterError', () => {
    const unified = httpStatusToUnified('openai', 401);
    try {
      throw new AdapterError(unified);
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError);
      expect((e as AdapterError).unified.code).toBe('unauthorized');
      expect((e as AdapterError).unified.retryable).toBe(false);
    }
  });
});
