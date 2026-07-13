import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  TASK_WEBHOOK_EVENT_HEADER,
  TASK_WEBHOOK_SIGNATURE_HEADER,
  verifyTaskWebhookSignature,
} from './webhook.js';

const SECRET = 'whsec_test_secret';

// --- task-center webhooks (§7.6 timestamped HMAC) --------------------------------

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
    // A body-only hex digest (no t=) is NOT a task signature.
    const bodyOnlyHex = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyTaskWebhookSignature(body, bodyOnlyHex, SECRET, { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: 'malformed-signature',
    });
  });

  it('exposes the task-webhook header names', () => {
    expect(TASK_WEBHOOK_SIGNATURE_HEADER).toBe('X-Actionow-Signature');
    expect(TASK_WEBHOOK_EVENT_HEADER).toBe('X-Actionow-Event');
  });
});
