import { describe, expect, it } from 'vitest';

import { AdapterError } from '../src/errors.js';
import type { WeightedChannel } from '../src/routing.js';
import {
  isRetryableAdapterError,
  orderForFailover,
  routeWithFailover,
  selectWeighted,
} from '../src/routing.js';

const channels = (): WeightedChannel<string>[] => [
  { id: 'a', weight: 1, value: 'a' },
  { id: 'b', weight: 3, value: 'b' },
];

const retryable = (): AdapterError =>
  new AdapterError({
    code: 'rate_limited',
    message: 'slow down',
    retryable: true,
  });

const nonRetryable = (): AdapterError =>
  new AdapterError({
    code: 'invalid_input',
    message: 'bad',
    retryable: false,
  });

describe('selectWeighted', () => {
  it('picks the first channel when rng lands in its cumulative band', () => {
    const picked = selectWeighted(channels(), () => 0.0);
    expect(picked.id).toBe('a');
  });

  it('picks the later channel when rng lands high in the cumulative band', () => {
    const picked = selectWeighted(channels(), () => 0.99);
    expect(picked.id).toBe('b');
  });

  it('throws for an empty channel list', () => {
    expect(() => selectWeighted<string>([], () => 0.0)).toThrow();
  });
});

describe('orderForFailover', () => {
  it('puts the weighted pick first, then the rest by descending weight', () => {
    const order = orderForFailover(channels(), () => 0.0); // pick 'a'
    expect(order.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('when the high-weight channel is picked, the rest follow by descending weight', () => {
    const three: WeightedChannel<string>[] = [
      { id: 'a', weight: 1, value: 'a' },
      { id: 'b', weight: 5, value: 'b' },
      { id: 'c', weight: 2, value: 'c' },
    ];
    // total weight 8; rng 0.5 → target 4 lands in b's band [1,6) → pick 'b'.
    const order = orderForFailover(three, () => 0.5);
    expect(order.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('isRetryableAdapterError', () => {
  it('is true for an AdapterError whose unified error is retryable', () => {
    expect(isRetryableAdapterError(retryable())).toBe(true);
  });

  it('is false for an AdapterError whose unified error is non-retryable', () => {
    expect(isRetryableAdapterError(nonRetryable())).toBe(false);
  });

  it('is false for unknown errors', () => {
    expect(isRetryableAdapterError(new Error('boom'))).toBe(false);
    expect(isRetryableAdapterError('nope')).toBe(false);
    expect(isRetryableAdapterError(undefined)).toBe(false);
  });
});

describe('routeWithFailover', () => {
  it('falls over to the next channel on a retryable error and returns its result', async () => {
    const attempted: string[] = [];
    const result = await routeWithFailover(
      channels(),
      () => 0.0, // weighted pick = 'a' first
      (value) => {
        attempted.push(value);
        if (value === 'a') {
          return Promise.reject(retryable());
        }
        return Promise.resolve(`ok:${value}`);
      },
      isRetryableAdapterError,
    );
    expect(result).toBe('ok:b');
    expect(attempted).toEqual(['a', 'b']);
  });

  it('rethrows immediately on a non-retryable error without attempting the next channel', async () => {
    const attempted: string[] = [];
    await expect(
      routeWithFailover(
        channels(),
        () => 0.0, // weighted pick = 'a' first
        (value) => {
          attempted.push(value);
          if (value === 'a') {
            return Promise.reject(nonRetryable());
          }
          return Promise.resolve(`ok:${value}`);
        },
        isRetryableAdapterError,
      ),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input', retryable: false } });
    expect(attempted).toEqual(['a']);
  });

  it('throws the last error when every channel fails retryably', async () => {
    const attempted: string[] = [];
    const lastError = new AdapterError({
      code: 'upstream_error',
      message: 'b failed',
      retryable: true,
    });
    await expect(
      routeWithFailover(
        channels(),
        () => 0.0,
        (value) => {
          attempted.push(value);
          if (value === 'b') {
            return Promise.reject(lastError);
          }
          return Promise.reject(retryable());
        },
        isRetryableAdapterError,
      ),
    ).rejects.toBe(lastError);
    expect(attempted).toEqual(['a', 'b']);
  });

  it('throws for an empty channel list', async () => {
    await expect(
      routeWithFailover<string, string>(
        [],
        () => 0.0,
        (value) => Promise.resolve(value),
        isRetryableAdapterError,
      ),
    ).rejects.toThrow();
  });

  it('orders remaining channels by descending weight after the weighted pick', async () => {
    const three: WeightedChannel<string>[] = [
      { id: 'low', weight: 1, value: 'low' },
      { id: 'mid', weight: 2, value: 'mid' },
      { id: 'high', weight: 5, value: 'high' },
    ];
    const attempted: string[] = [];
    await expect(
      routeWithFailover(
        three,
        () => 0.0, // weighted pick = 'low' (first cumulative band)
        (value) => {
          attempted.push(value);
          return Promise.reject(retryable());
        },
        isRetryableAdapterError,
      ),
    ).rejects.toThrow();
    // weighted pick first ('low'), then remaining by descending weight: high (5), mid (2)
    expect(attempted).toEqual(['low', 'high', 'mid']);
  });
});
