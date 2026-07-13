import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  TASK_WEBHOOK_EVENT_HEADER,
  TASK_WEBHOOK_SIGNATURE_HEADER,
  verifyTaskWebhookSignature,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from './webhook.js';

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

// --- NEW task-center webhooks (§7.6 timestamped HMAC) --------------------------------

/** Recompute the timestamped signature core sends, matching engine `signTaskWebhook`. */
function signTask(body: string, tsSeconds: number, secret = SECRET): string {
  const mac = createHmac('sha256', secret)
    .update(`${String(tsSeconds)}.${body}`)
    .digest('hex');
  return `t=${String(tsSeconds)},v1=${mac}`;
}

describe('verifyTaskWebhookSignature', () => {
  const NOW = 1_752_400_000;
  const body = JSON.stringify({
    evt_id: 'evt_task-1_succeeded',
    event_type: 'task.succeeded',
    created_at: '2026-07-13T00:00:00.000Z',
    task: { id: 'task-1', object: 'task', status: 'succeeded' },
  });

  it('accepts a fresh, correct signature (string and Buffer bodies)', () => {
    const header = signTask(body, NOW);
    expect(verifyTaskWebhookSignature(body, header, SECRET, { nowSeconds: NOW })).toEqual({
      valid: true,
      timestamp: NOW,
    });
    expect(
      verifyTaskWebhookSignature(Buffer.from(body, 'utf8'), header, SECRET, { nowSeconds: NOW }),
    ).toEqual({ valid: true, timestamp: NOW });
  });

  it('accepts within the ±300s default window and rejects beyond it', () => {
    const header = signTask(body, NOW);
    expect(verifyTaskWebhookSignature(body, header, SECRET, { nowSeconds: NOW + 299 }).valid).toBe(
      true,
    );
    expect(verifyTaskWebhookSignature(body, header, SECRET, { nowSeconds: NOW + 301 })).toEqual({
      valid: false,
      reason: 'stale-timestamp',
    });
  });

  it('rejects a tampered body and a wrong secret', () => {
    const header = signTask(body, NOW);
    const tampered = body.replace('succeeded', 'failed');
    expect(verifyTaskWebhookSignature(tampered, header, SECRET, { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: 'invalid-signature',
    });
    expect(verifyTaskWebhookSignature(body, header, 'whsec_other', { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: 'invalid-signature',
    });
  });

  it('reports missing and malformed headers distinctly', () => {
    expect(verifyTaskWebhookSignature(body, undefined, SECRET, { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: 'missing-signature',
    });
    expect(verifyTaskWebhookSignature(body, 'v1=deadbeef', SECRET, { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: 'malformed-signature',
    });
    // The legacy body-only hex (no t=) is NOT a task signature.
    expect(verifyTaskWebhookSignature(body, sign(body), SECRET, { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: 'malformed-signature',
    });
  });

  it('exposes the task-webhook header names', () => {
    expect(TASK_WEBHOOK_SIGNATURE_HEADER).toBe('X-Actionow-Signature');
    expect(TASK_WEBHOOK_EVENT_HEADER).toBe('X-Actionow-Event');
  });
});
