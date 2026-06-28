import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from './webhook.js';

const SECRET = 'whsec_test_secret';

/** Recompute the signature core would send, matching `signPayload` in the engine. */
function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('exposes the header name core signs with', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Actionow-Signature');
  });

  it('accepts a correct signature over the raw string body', () => {
    const body = JSON.stringify({ job_id: 'job_1', status: 'succeeded' });

    const result = verifyWebhookSignature(body, sign(body), SECRET);

    expect(result.valid).toBe(true);
  });

  it('accepts a correct signature over a Buffer body (express.raw shape)', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');

    const result = verifyWebhookSignature(body, sign(body.toString('utf8')), SECRET);

    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ job_id: 'job_1', status: 'succeeded' });
    const signature = sign(body);
    const tampered = JSON.stringify({ job_id: 'job_1', status: 'failed' });

    const result = verifyWebhookSignature(tampered, signature, SECRET);

    expect(result).toEqual({ valid: false, reason: 'invalid-signature' });
  });

  it('rejects a signature made with the wrong secret', () => {
    const body = JSON.stringify({ ok: true });

    const result = verifyWebhookSignature(body, sign(body, 'other-secret'), SECRET);

    expect(result).toEqual({ valid: false, reason: 'invalid-signature' });
  });

  it('reports missing-signature distinctly when the header is absent (unsigned delivery)', () => {
    const body = JSON.stringify({ ok: true });

    expect(verifyWebhookSignature(body, undefined, SECRET)).toEqual({
      valid: false,
      reason: 'missing-signature',
    });
    expect(verifyWebhookSignature(body, '', SECRET)).toEqual({
      valid: false,
      reason: 'missing-signature',
    });
  });

  it('takes the first value when the header arrives as an array (Node raw headers)', () => {
    const body = JSON.stringify({ ok: true });
    const good = sign(body);

    expect(verifyWebhookSignature(body, [good, 'ignored'], SECRET).valid).toBe(true);
  });

  it('rejects (does not throw) a malformed signature of a different length', () => {
    const body = JSON.stringify({ ok: true });

    const result = verifyWebhookSignature(body, 'deadbeef', SECRET);

    expect(result).toEqual({ valid: false, reason: 'invalid-signature' });
  });
});
