import { describe, expect, it, vi } from 'vitest';

import { creditsToMicro, formatCredits, MICRO_PER_CREDIT } from '../src/core-kit/money.js';
import { callWithRetry } from '../src/core-kit/retry.js';

describe('money', () => {
  it('formats µcredit string to credits', () => {
    expect(formatCredits('1500000')).toBe('1.5');
    expect(formatCredits(1234567n, 2)).toBe('1.23');
    expect(formatCredits('1000000')).toBe('1');
  });
  it('converts human credits to µcredit bigint', () => {
    expect(creditsToMicro(2)).toBe(2n * MICRO_PER_CREDIT);
  });
});

describe('callWithRetry', () => {
  it('does NOT retry a non-retryable 402', async () => {
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'insufficient_credits', retryable: false } }), { status: 402 }),
    );
    await expect(callWithRetry(fn, { max: 3, baseMs: 1 })).rejects.toMatchObject({ code: 'insufficient_credits' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('retries a retryable 429 then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () =>
      ++n < 2
        ? new Response(JSON.stringify({ error: { code: 'rate_limited', retryable: true, retry_after_ms: 1 } }), { status: 429 })
        : new Response('{}', { status: 200 }),
    );
    const res = await callWithRetry(fn, { max: 3, baseMs: 1 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
