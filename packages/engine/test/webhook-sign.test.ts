import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { backoffMs, SIGNATURE_HEADER, signPayload } from '../src/webhook.js';

describe('signPayload', () => {
  it('produces a stable HMAC-SHA256 hex digest', () => {
    const sig = signPayload('topsecret', '{"job_id":"abc"}');
    // 32-byte digest → 64 hex chars
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // deterministic for the same secret + body
    expect(signPayload('topsecret', '{"job_id":"abc"}')).toBe(sig);
  });

  it('matches an independent HMAC computation (verifiable by a receiver)', () => {
    const secret = 'whsec_123';
    const body = JSON.stringify({ job_id: 'job-1', status: 'succeeded' });
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(signPayload(secret, body)).toBe(expected);
  });

  it('changes when the secret or body changes', () => {
    const base = signPayload('s1', 'body');
    expect(signPayload('s2', 'body')).not.toBe(base);
    expect(signPayload('s1', 'body2')).not.toBe(base);
  });

  it('exposes the canonical signature header name', () => {
    expect(SIGNATURE_HEADER).toBe('X-Actionow-Signature');
  });
});

describe('backoffMs', () => {
  it('grows exponentially from the base and caps at the max', () => {
    expect(backoffMs(1, 1000, 60_000)).toBe(1000);
    expect(backoffMs(2, 1000, 60_000)).toBe(2000);
    expect(backoffMs(3, 1000, 60_000)).toBe(4000);
    expect(backoffMs(4, 1000, 60_000)).toBe(8000);
    // capped
    expect(backoffMs(20, 1000, 60_000)).toBe(60_000);
  });
});
