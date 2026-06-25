import { describe, expect, it } from 'vitest';

import {
  createFaultPolicySchema,
  faultPolicyViewSchema,
  updateFaultPolicySchema,
} from './fault-policy.js';

describe('fault policy view contract', () => {
  const base = {
    id: 'fp1',
    name: 'default',
    fast_fail: false,
    retry_count: 2,
    backoff_type: 'exponential',
    backoff_ms: 200,
    connect_timeout_ms: null,
    ttft_timeout_ms: null,
    total_timeout_ms: null,
    idle_timeout_ms: null,
    retry_codes: null,
    retry_messages: null,
    status: 'active',
    description: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('carries the 8 circuit-breaker fields (breaker_enabled bool, the rest nullable numbers)', () => {
    const v = {
      ...base,
      breaker_enabled: true,
      breaker_window_ms: 60000,
      breaker_min_volume: 20,
      breaker_failure_rate_pct: 50,
      breaker_half_open_trial: 3,
      breaker_half_open_successes: 2,
      breaker_open_cooldown_ms: 5000,
      breaker_open_cooldown_cap_ms: 300000,
    };
    expect(faultPolicyViewSchema.parse(v)).toEqual(v);
    // nullable numeric fields accept null (fall back to global defaults)
    expect(
      faultPolicyViewSchema.parse({
        ...v,
        breaker_window_ms: null,
        breaker_min_volume: null,
        breaker_failure_rate_pct: null,
        breaker_half_open_trial: null,
        breaker_half_open_successes: null,
        breaker_open_cooldown_ms: null,
        breaker_open_cooldown_cap_ms: null,
      }).breaker_window_ms,
    ).toBeNull();
    // breaker_enabled is required and must be a boolean
    expect(() => faultPolicyViewSchema.parse({ ...v, breaker_enabled: undefined })).toThrow();
    expect(() => faultPolicyViewSchema.parse({ ...v, breaker_enabled: 'yes' })).toThrow();
  });
});

describe('fault policy request contracts', () => {
  it('create accepts optional breaker fields and bounds failure_rate_pct to 0–100', () => {
    expect(
      createFaultPolicySchema.parse({
        name: 'fp',
        breakerEnabled: false,
        breakerWindowMs: 30000,
        breakerFailureRatePct: 75,
      }),
    ).toMatchObject({ breakerEnabled: false, breakerFailureRatePct: 75 });
    // omitting them is fine (fall back to global defaults)
    expect(createFaultPolicySchema.parse({ name: 'fp' }).breakerEnabled).toBeUndefined();
    // failure_rate_pct must be within 0–100
    expect(() =>
      createFaultPolicySchema.parse({ name: 'fp', breakerFailureRatePct: 101 }),
    ).toThrow();
    // numeric thresholds must be non-negative integers
    expect(() => createFaultPolicySchema.parse({ name: 'fp', breakerWindowMs: -1 })).toThrow();
  });

  it('update accepts the same optional breaker fields', () => {
    expect(updateFaultPolicySchema.parse({ breakerEnabled: true }).breakerEnabled).toBe(true);
    expect(updateFaultPolicySchema.parse({ breakerMinVolume: 10 }).breakerMinVolume).toBe(10);
    expect(() => updateFaultPolicySchema.parse({ breakerFailureRatePct: -5 })).toThrow();
  });
});
