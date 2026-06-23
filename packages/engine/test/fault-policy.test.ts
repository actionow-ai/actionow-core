import { AdapterError } from '@actionow/adapters';
import type { HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type FaultPolicy,
  type FaultPolicyClock,
  runWithFaultPolicy,
  shouldRetrySameChannel,
  wrapHttpWithTimeouts,
} from '../src/fault-policy.js';

/** An empty async iterable of strings (a stream body with no chunks). */
const emptyLines: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
};

/** A no-op clock that records every backoff delay it was asked to sleep. */
function fakeClock(): FaultPolicyClock & { delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: (ms) => (delays.push(ms), Promise.resolve()) };
}

const base: FaultPolicy = {
  fastFail: false,
  retryCount: 0,
  backoffType: 'fixed',
  backoffMs: 0,
};

const adapterErr = (code: AdapterError['unified']['code'], message = 'boom', retryable = true) =>
  new AdapterError({ code, message, retryable });

describe('runWithFaultPolicy', () => {
  it('runs the attempt exactly once when there is no policy', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    await expect(runWithFaultPolicy(undefined, attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry under fastFail even with retryCount set', async () => {
    const attempt = vi.fn().mockRejectedValue(adapterErr('rate_limited'));
    const clock = fakeClock();
    await expect(
      runWithFaultPolicy({ ...base, fastFail: true, retryCount: 3 }, attempt, clock),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
  });

  it('retries up to retryCount on a retryable error, then throws (1 + retryCount attempts)', async () => {
    const attempt = vi.fn().mockRejectedValue(adapterErr('rate_limited'));
    const clock = fakeClock();
    await expect(
      runWithFaultPolicy({ ...base, retryCount: 2, backoffMs: 10 }, attempt, clock),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(clock.delays).toEqual([10, 10]); // fixed backoff between retries
  });

  it('returns as soon as an attempt succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(adapterErr('rate_limited'))
      .mockResolvedValueOnce('ok');
    await expect(
      runWithFaultPolicy({ ...base, retryCount: 3 }, attempt, fakeClock()),
    ).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff when configured (base, 2×, 4× …)', async () => {
    const attempt = vi.fn().mockRejectedValue(adapterErr('rate_limited'));
    const clock = fakeClock();
    await expect(
      runWithFaultPolicy(
        { ...base, retryCount: 3, backoffType: 'exponential', backoffMs: 100 },
        attempt,
        clock,
      ),
    ).rejects.toThrow();
    expect(clock.delays).toEqual([100, 200, 400]);
  });

  it('does not retry an error that fails the trigger match (codes configured)', async () => {
    // Only 500 triggers a retry; a 429 (rate_limited) must NOT be retried.
    const attempt = vi.fn().mockRejectedValue(adapterErr('rate_limited'));
    const clock = fakeClock();
    await expect(
      runWithFaultPolicy({ ...base, retryCount: 3, retryCodes: [500] }, attempt, clock),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('shouldRetrySameChannel', () => {
  it('falls back to the adapter retryable verdict when no triggers configured', () => {
    expect(
      shouldRetrySameChannel(adapterErr('rate_limited', 'x', true), { ...base, retryCount: 1 }),
    ).toBe(true);
    expect(
      shouldRetrySameChannel(adapterErr('invalid_input', 'x', false), { ...base, retryCount: 1 }),
    ).toBe(false);
  });

  it('matches a configured HTTP code via the http→unified mapping (404 → resource_not_found)', () => {
    const policy = { ...base, retryCount: 1, retryCodes: [404] };
    expect(shouldRetrySameChannel(adapterErr('resource_not_found', 'nope', false), policy)).toBe(
      true,
    );
    // A different code does not match.
    expect(shouldRetrySameChannel(adapterErr('rate_limited', 'slow', true), policy)).toBe(false);
  });

  it('matches a configured message substring (case-insensitive)', () => {
    const policy = { ...base, retryCount: 1, retryMessages: ['internal server error'] };
    expect(
      shouldRetrySameChannel(
        adapterErr('upstream_error', 'Upstream: Internal Server Error', false),
        policy,
      ),
    ).toBe(true);
    expect(shouldRetrySameChannel(adapterErr('upstream_error', 'bad gateway', false), policy)).toBe(
      false,
    );
  });

  it('returns false under fastFail or zero retryCount', () => {
    expect(
      shouldRetrySameChannel(adapterErr('rate_limited'), {
        ...base,
        fastFail: true,
        retryCount: 5,
      }),
    ).toBe(false);
    expect(shouldRetrySameChannel(adapterErr('rate_limited'), { ...base, retryCount: 0 })).toBe(
      false,
    );
  });
});

describe('wrapHttpWithTimeouts', () => {
  function recordingClient(): HttpClient & { last?: HttpRequest; lastStream?: HttpRequest } {
    const client: HttpClient & { last?: HttpRequest; lastStream?: HttpRequest } = {
      request: (req) => {
        client.last = req;
        return Promise.resolve({ status: 200, ok: true, body: {}, text: '' });
      },
      stream: (req) => {
        client.lastStream = req;
        return Promise.resolve({ status: 200, ok: true, lines: emptyLines });
      },
    };
    return client;
  }

  it('returns the same client when there is no policy or no timeouts', () => {
    const c = recordingClient();
    expect(wrapHttpWithTimeouts(c, undefined)).toBe(c);
    expect(wrapHttpWithTimeouts(c, base)).toBe(c);
  });

  it('injects total + connect timeouts on request()', async () => {
    const c = recordingClient();
    const wrapped = wrapHttpWithTimeouts(c, {
      ...base,
      totalTimeoutMs: 5000,
      connectTimeoutMs: 1500,
    });
    await wrapped.request({ method: 'POST', url: 'https://x' });
    expect(c.last?.timeoutMs).toBe(5000);
    expect(c.last?.connectTimeoutMs).toBe(1500);
  });

  it('injects ttft + idle timeouts on stream()', async () => {
    const c = recordingClient();
    const wrapped = wrapHttpWithTimeouts(c, { ...base, ttftTimeoutMs: 8000, idleTimeoutMs: 3000 });
    await wrapped.stream?.({ method: 'POST', url: 'https://x' });
    expect(c.lastStream?.firstChunkTimeoutMs).toBe(8000);
    expect(c.lastStream?.idleTimeoutMs).toBe(3000);
  });

  it('never overrides a timeout the caller already set', async () => {
    const c = recordingClient();
    const wrapped = wrapHttpWithTimeouts(c, { ...base, totalTimeoutMs: 5000 });
    await wrapped.request({ method: 'POST', url: 'https://x', timeoutMs: 999 });
    expect(c.last?.timeoutMs).toBe(999);
  });

  it('omits stream when the inner client has none', () => {
    const reqOnly: HttpClient = {
      request: () => Promise.resolve({ status: 200, ok: true, body: {}, text: '' }),
    };
    const wrapped = wrapHttpWithTimeouts(reqOnly, { ...base, totalTimeoutMs: 5000 });
    expect(wrapped.stream === undefined).toBe(true);
  });
});
