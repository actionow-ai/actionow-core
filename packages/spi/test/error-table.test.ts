// ErrorTable (§6-⑤ per-provider 错误码表 → 统一 taxonomy): ordered first-match
// resolution, range statuses, mandatory fallback, and the completeness report
// the conformance gate consumes.
import { gatewayErrorSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import type { ErrorTable } from '../src/index.js';
import { errorTableCompleteness, resolveError, STANDARD_ERROR_PROBES } from '../src/index.js';
import { TABLE } from './stub.js';

describe('resolveError', () => {
  it('first matching row wins (declaration order = priority)', () => {
    const table: ErrorTable = {
      rows: [
        {
          match: { httpStatus: 429, upstreamCode: 'daily_cap' },
          code: 'insufficient_credits',
          retryable: false,
          failover: false,
        },
        { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
      ],
      fallback: { code: 'upstream_error', retryable: false, failover: true },
    };
    expect(resolveError(table, { httpStatus: 429, upstreamCode: 'daily_cap' }).code).toBe(
      'insufficient_credits',
    );
    expect(resolveError(table, { httpStatus: 429 }).code).toBe('rate_limited');
  });

  it('matches inclusive [lo, hi] status ranges', () => {
    expect(resolveError(TABLE, { httpStatus: 500 }).code).toBe('upstream_error');
    expect(resolveError(TABLE, { httpStatus: 503 }).code).toBe('upstream_error');
    expect(resolveError(TABLE, { httpStatus: 599 }).code).toBe('upstream_error');
    expect(resolveError(TABLE, { httpStatus: 499 }).code).not.toBe('rate_limited');
  });

  it('matches messageIncludes case-insensitively and upstreamCode exactly', () => {
    const table: ErrorTable = {
      rows: [
        {
          match: { messageIncludes: 'Content Policy' },
          code: 'content_filtered',
          retryable: false,
          failover: false,
        },
        {
          match: { upstreamCode: 'E1002' },
          code: 'invalid_input',
          retryable: false,
          failover: false,
        },
      ],
      fallback: { code: 'upstream_error', retryable: true, failover: true },
    };
    expect(
      resolveError(table, { httpStatus: 200, message: 'blocked by CONTENT policy filters' }).code,
    ).toBe('content_filtered');
    expect(resolveError(table, { upstreamCode: 'E1002' }).code).toBe('invalid_input');
    expect(resolveError(table, { upstreamCode: 'E10020' }).code).toBe('upstream_error');
  });

  it('kind rows classify transport-level timeout/network probes; http probes never hit them', () => {
    expect(resolveError(TABLE, { kind: 'timeout', message: 'timed out' }).code).toBe(
      'upstream_timeout',
    );
    expect(resolveError(TABLE, { kind: 'network', message: 'ECONNRESET' }).code).toBe(
      'upstream_error',
    );
    // An http probe (default kind) with no status matches neither status rows nor kind rows → fallback.
    expect(resolveError(TABLE, { message: 'timed out' })).toMatchObject({
      code: TABLE.fallback.code,
      retryable: TABLE.fallback.retryable,
    });
  });

  it('falls back when nothing matches, and carries provenance + Retry-After through', () => {
    const error = resolveError(TABLE, {
      httpStatus: 418,
      upstreamCode: 'teapot',
      message: 'I am a teapot',
      provider: 'stub',
      retryAfterMs: 1_500,
    });
    expect(error).toEqual({
      code: 'upstream_error',
      message: 'I am a teapot',
      retryable: false,
      failover: true,
      upstream: { provider: 'stub', rawCode: 'teapot' },
      retryAfterMs: 1_500,
    });
    expect(gatewayErrorSchema.parse(error)).toEqual(error); // frozen-IR-valid envelope
  });

  it('produces a schema-valid GatewayError for every standard probe', () => {
    for (const { probe } of STANDARD_ERROR_PROBES) {
      expect(() => gatewayErrorSchema.parse(resolveError(TABLE, probe))).not.toThrow();
    }
  });
});

describe('errorTableCompleteness', () => {
  it('a fully covered table reports complete with every probe via an explicit row', () => {
    const report = errorTableCompleteness(TABLE);
    expect(report.complete).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.entries).toHaveLength(STANDARD_ERROR_PROBES.length);
    expect(report.entries.every((entry) => entry.via === 'row')).toBe(true);
  });

  it('reports the missing tiers of a table that only fallbacks them', () => {
    const gappy: ErrorTable = {
      rows: [
        { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
        {
          match: { httpStatus: [500, 599] },
          code: 'upstream_error',
          retryable: true,
          failover: true,
        },
      ],
      fallback: { code: 'upstream_error', retryable: false, failover: true },
    };
    const report = errorTableCompleteness(gappy);
    expect(report.complete).toBe(false);
    expect(report.missing).toEqual([
      'http:400',
      'http:401',
      'http:403',
      'http:404',
      'http:408',
      'timeout',
      'network',
    ]);
    const covered = report.entries.find((entry) => entry.probe === 'http:429');
    expect(covered).toMatchObject({ via: 'row', rowIndex: 0, code: 'rate_limited' });
    const missed = report.entries.find((entry) => entry.probe === 'timeout');
    expect(missed).toMatchObject({ via: 'fallback', code: 'upstream_error' });
    expect(missed?.rowIndex).toBeUndefined();
  });
});
