#!/usr/bin/env node
// verify-webhook.mjs — verify an Actionow TASK-webhook signature (the NEW
// timestamped scheme), and (optionally) run a tiny receiver that verifies live
// deliveries over the RAW request bytes. Zero dependencies (node:crypto + node:http).
//
// The task-webhook delivery is a signed EVENT ENVELOPE carrying the FULL task:
//   { evt_id, event_type, created_at, task: { id, object:"task", status, output, … } }
// Headers: X-Actionow-Event: task.running|task.progress|task.succeeded|task.failed|task.canceled
//          X-Actionow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
// Dedupe on evt_id — retries reuse the SAME evt_id. The secret is TENANT-LEVEL
// configuration on the core side (ask your platform operator).
//
//   Env:   ACTIONOW_WEBHOOK_SECRET
//
//   As a library check:  node verify-webhook.mjs <rawBodyFile> '<signatureHeader>'
//                        (signatureHeader = the full "t=…,v1=…" value)
//   As a live receiver:  PORT=8787 node verify-webhook.mjs --serve
//                        → POST deliveries to http://localhost:8787/webhooks/actionow-tasks
//   NOTE: callback_url must be PUBLIC — Actionow's egress guard drops
//   localhost/private targets. Expose this receiver via a tunnel (ngrok, etc.).
//
//   LEGACY: deliveries from the deprecated /v1/run face are signed with a
//   body-only HMAC (no timestamp, bare hex header) — verify those with
//   @actionow/sdk's verifyWebhookSignature, not this script.

import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const SECRET = process.env.ACTIONOW_WEBHOOK_SECRET;
const SIGNATURE_HEADER = 'x-actionow-signature'; // node lowercases header names
const EVENT_HEADER = 'x-actionow-event';
const TOLERANCE_SECONDS = 300; // each retry attempt is re-signed fresh, so ±300s is safe

/**
 * Verify the timestamped task-webhook signature in constant time.
 * `rawBody` MUST be the exact bytes received — never JSON.parse then re-stringify.
 * Header format: `t=<unix seconds>,v1=<hex>`; digest = HMAC-SHA256(secret, `${t}.${rawBody}`).
 */
export function verifyTaskWebhookSignature(rawBody, signatureHeader, secret, nowSeconds) {
  const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!sig) return { valid: false, reason: 'missing-signature' };
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(sig).trim());
  if (!m) return { valid: false, reason: 'malformed-signature' };
  const ts = Number(m[1]);
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'stale-timestamp' };
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const a = Buffer.from(m[2]);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { valid: true, timestamp: ts } : { valid: false, reason: 'invalid-signature' };
}

if (!SECRET) { console.error('set ACTIONOW_WEBHOOK_SECRET'); process.exit(2); }

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT ?? 8787);
  const seen = new Set(); // evt_id dedupe — retries reuse the same evt_id
  http
    .createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks); // RAW bytes — do not parse before verifying
        const result = verifyTaskWebhookSignature(rawBody, req.headers[SIGNATURE_HEADER], SECRET);
        if (!result.valid) {
          console.error(`rejected: ${result.reason}`);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: result.reason }));
          return;
        }
        res.writeHead(200).end('ok'); // ack FAST — 2xx stops the retry ladder

        // The envelope carries the FULL task — no follow-up fetch needed.
        const evt = JSON.parse(rawBody.toString('utf8'));
        if (seen.has(evt.evt_id)) {
          console.log(`duplicate delivery ${evt.evt_id} (already processed) — ignored`);
          return;
        }
        seen.add(evt.evt_id);
        const eventType = req.headers[EVENT_HEADER] ?? evt.event_type;
        const task = evt.task ?? {};
        if (eventType === 'task.failed') {
          console.log(`task ${task.id} FAILED:`, JSON.stringify(task.error));
        } else if (eventType === 'task.succeeded') {
          console.log(`task ${task.id} succeeded · output:`, JSON.stringify(task.output));
        } else {
          console.log(`task ${task.id} → ${eventType}${task.progress != null ? ` (${task.progress}%)` : ''}`);
        }
      });
    })
    .listen(port, () => console.error(`listening for Actionow task webhooks on :${port}/webhooks/actionow-tasks`));
} else {
  // library mode: verify a captured delivery from a file
  const [file, sig] = process.argv.slice(2);
  if (!file || !sig) { console.error("usage: node verify-webhook.mjs <rawBodyFile> 't=…,v1=…'  |  --serve"); process.exit(2); }
  const result = verifyTaskWebhookSignature(readFileSync(file), sig, SECRET);
  console.log(JSON.stringify(result));
  process.exit(result.valid ? 0 : 1);
}
