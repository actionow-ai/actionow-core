import { describe, expect, it } from 'vitest';

import {
  cooldownMs,
  DEFAULT_BREAKER_CONFIG,
  onFailureTransition,
  onSuccessTransition,
  openEligibleAt,
  resolveBreakerConfig,
} from '../src/breaker.js';

const cfg = DEFAULT_BREAKER_CONFIG;
const t0 = new Date('2026-06-25T00:00:00Z');
const closed = {
  state: 'closed' as const,
  openedAt: null,
  cooldownUntil: null,
  tripCount: 0,
  halfOpenSuccesses: 0,
};

describe('breaker FSM (弹性2.0)', () => {
  it('cooldown backs off exponentially with a cap', () => {
    expect(cooldownMs(cfg, 0)).toBe(5000);
    expect(cooldownMs(cfg, 1)).toBe(10000);
    expect(cooldownMs(cfg, 6)).toBe(300000); // capped
  });

  it('trips closed→open only at/above min_volume AND failure_rate', () => {
    expect(onFailureTransition(closed, cfg, { total: 10, fail: 9 }, t0)).toBeNull(); // below min_volume
    const next = onFailureTransition(closed, cfg, { total: 20, fail: 10 }, t0); // 50% >= 50%
    expect(next?.state).toBe('open');
    expect(next?.tripCount).toBe(1);
    expect(next?.cooldownUntil?.getTime()).toBe(t0.getTime() + 5000);
  });

  it('half_open: a success short of threshold stays half_open; reaching it closes', () => {
    const ho = {
      state: 'half_open' as const,
      openedAt: t0,
      cooldownUntil: t0,
      tripCount: 2,
      halfOpenSuccesses: 0,
    };
    const s1 = onSuccessTransition(ho, cfg);
    expect(s1?.state).toBe('half_open');
    expect(s1?.halfOpenSuccesses).toBe(1);
    const s2 = onSuccessTransition({ ...ho, halfOpenSuccesses: 1 }, cfg);
    expect(s2?.state).toBe('closed');
    expect(s2?.tripCount).toBe(0);
  });

  it('half_open: any failure reopens with doubled cooldown', () => {
    const ho = {
      state: 'half_open' as const,
      openedAt: t0,
      cooldownUntil: t0,
      tripCount: 1,
      halfOpenSuccesses: 1,
    };
    const next = onFailureTransition(ho, cfg, { total: 1, fail: 1 }, t0);
    expect(next?.state).toBe('open');
    expect(next?.tripCount).toBe(2);
    expect(next?.cooldownUntil?.getTime()).toBe(t0.getTime() + cooldownMs(cfg, 1));
  });

  it('openEligibleAt: an open row past cooldown is half_open-eligible', () => {
    const open = {
      state: 'open' as const,
      openedAt: t0,
      cooldownUntil: new Date(t0.getTime() + 5000),
      tripCount: 1,
      halfOpenSuccesses: 0,
    };
    expect(openEligibleAt(open, new Date(t0.getTime() + 4000))).toBe(false);
    expect(openEligibleAt(open, new Date(t0.getTime() + 6000))).toBe(true);
  });

  it('does not trip when breaker is disabled', () => {
    const disabled = { ...cfg, enabled: false };
    expect(onFailureTransition(closed, disabled, { total: 20, fail: 20 }, t0)).toBeNull();
  });

  it('a failure while already open does not re-transition', () => {
    const open = {
      state: 'open' as const,
      openedAt: t0,
      cooldownUntil: new Date(t0.getTime() + 5000),
      tripCount: 1,
      halfOpenSuccesses: 0,
    };
    expect(onFailureTransition(open, cfg, { total: 20, fail: 20 }, t0)).toBeNull();
  });

  it('a success while closed/open does not transition', () => {
    expect(onSuccessTransition(closed, cfg)).toBeNull();
    const open = {
      state: 'open' as const,
      openedAt: t0,
      cooldownUntil: new Date(t0.getTime() + 5000),
      tripCount: 1,
      halfOpenSuccesses: 0,
    };
    expect(onSuccessTransition(open, cfg)).toBeNull();
  });

  it('openEligibleAt is false for a non-open or cooldown-less row', () => {
    expect(openEligibleAt(closed, t0)).toBe(false);
    const openNoCooldown = {
      state: 'open' as const,
      openedAt: t0,
      cooldownUntil: null,
      tripCount: 1,
      halfOpenSuccesses: 0,
    };
    expect(openEligibleAt(openNoCooldown, new Date(t0.getTime() + 9_999_999))).toBe(false);
  });
});

describe('resolveBreakerConfig (弹性2.0)', () => {
  it('returns the global defaults when no policy is given', () => {
    expect(resolveBreakerConfig()).toEqual(DEFAULT_BREAKER_CONFIG);
    expect(resolveBreakerConfig(undefined)).toEqual(DEFAULT_BREAKER_CONFIG);
  });

  it('falls back per-field on null/undefined columns', () => {
    expect(
      resolveBreakerConfig({
        breakerEnabled: false,
        breakerWindowMs: 30_000,
        breakerMinVolume: null,
        breakerFailureRatePct: 80,
        breakerHalfOpenTrial: undefined,
        breakerHalfOpenSuccesses: null,
        breakerOpenCooldownMs: 1_000,
        breakerOpenCooldownCapMs: null,
      }),
    ).toEqual({
      enabled: false,
      windowMs: 30_000,
      minVolume: DEFAULT_BREAKER_CONFIG.minVolume,
      failureRatePct: 80,
      halfOpenTrial: DEFAULT_BREAKER_CONFIG.halfOpenTrial,
      halfOpenSuccesses: DEFAULT_BREAKER_CONFIG.halfOpenSuccesses,
      openCooldownMs: 1_000,
      openCooldownCapMs: DEFAULT_BREAKER_CONFIG.openCooldownCapMs,
    });
  });
});
