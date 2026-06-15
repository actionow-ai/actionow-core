import { describe, expect, it } from 'vitest';

import type { ExecMode, SubmitResult, UnifiedError, UnifiedErrorCode } from '../src/adapter.js';
import { EXEC_MODES, UNIFIED_ERROR_CODES } from '../src/adapter.js';

describe('adapter contract constants', () => {
  it('exposes the four exec modes', () => {
    expect(EXEC_MODES).toEqual(['blocking', 'stream', 'async-poll', 'async-callback']);
    const mode: ExecMode = 'blocking';
    expect(EXEC_MODES).toContain(mode);
  });

  it('exposes the ten unified error codes', () => {
    expect(UNIFIED_ERROR_CODES).toEqual([
      'invalid_input',
      'insufficient_credits',
      'resource_not_found',
      'rate_limited',
      'upstream_error',
      'upstream_timeout',
      'content_filtered',
      'job_failed',
      'unauthorized',
      'internal_error',
    ]);
    const code: UnifiedErrorCode = 'rate_limited';
    expect(UNIFIED_ERROR_CODES).toContain(code);
  });

  it('discriminates SubmitResult on `kind`', () => {
    const sync: SubmitResult = { kind: 'sync', output: { text: 'hi' }, usage: { input_tokens: 1 } };
    const async_: SubmitResult = { kind: 'async', provider: 'p', upstreamJobId: 'j' };
    expect(sync.kind).toBe('sync');
    expect(async_.kind).toBe('async');
  });

  it('models a UnifiedError with retryable flag', () => {
    const err: UnifiedError = { code: 'rate_limited', message: 'slow down', retryable: true };
    expect(err.retryable).toBe(true);
  });
});
