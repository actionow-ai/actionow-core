#!/usr/bin/env node
// verify-webhook.mjs — verify an Actionow job webhook signature, and (optionally)
// run a tiny receiver that verifies live deliveries over the RAW request bytes.
// Zero dependencies (node:crypto + node:http).
//
// IMPORTANT: the outbound webhook body is MINIMAL — `{ job_id }` on success,
// `{ job_id, error }` on failure. It carries NO status/output/cost. To get the
// result, fetch GET /v1/jobs/:job_id with your ak_ data-plane key (see below).
//
//   Env:   ACTIONOW_WEBHOOK_SECRET
//          ACTIONOW_BASE_URL, ACTIONOW_API_KEY   (only if you want the receiver to fetch the job)
//
//   As a library check:  node verify-webhook.mjs <rawBodyFile> <hexSignature>
//   As a live receiver:  PORT=8787 node verify-webhook.mjs --serve
//                        → POST deliveries to http://localhost:8787/webhooks/actionow
//   NOTE: callback_url must be PUBLIC — Actionow's egress guard dead-letters
//   localhost/private targets. Expose this receiver via a tunnel (ngrok, etc.).

import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const SECRET = process.env.ACTIONOW_WEBHOOK_SECRET;
const SIGNATURE_HEADER = 'x-actionow-signature'; // node lowercases header names

/**
 * Verify HMAC-SHA256(secret, rawBody) === signature, in constant time.
 * `rawBody` MUST be the exact bytes received — never JSON.parse then re-stringify.
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return { valid: false, reason: 'missing-signature' };
  const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { valid: true } : { valid: false, reason: 'invalid-signature' };
}

// Fetch the authoritative job result — the webhook body does NOT contain it.
async function fetchJob(jobId) {
  const base = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
  const key = process.env.ACTIONOW_API_KEY;
  if (!base || !key) return null; // receiver can still ack; fetch is optional here
  const res = await fetch(`${base}/v1/jobs/${jobId}`, { headers: { authorization: `Bearer ${key}` } });
  return res.ok ? res.json() : null;
}

if (!SECRET) { console.error('set ACTIONOW_WEBHOOK_SECRET'); process.exit(2); }

if (process.argv.includes('--serve')) {
  const port = Number(process.env.PORT ?? 8787);
  http
    .createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const rawBody = Buffer.concat(chunks); // RAW bytes — do not parse before verifying
        const result = verifyWebhookSignature(rawBody, req.headers[SIGNATURE_HEADER], SECRET);
        if (!result.valid) {
          console.error(`✗ rejected: ${result.reason}`);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: result.reason }));
          return;
        }
        res.writeHead(200).end('ok'); // ack FAST — 2xx → Actionow marks the delivery `sent`

        // The body is just { job_id } (or { job_id, error } on failure). Do the
        // real work out of band: on failure record the error; else fetch the job.
        const ping = JSON.parse(rawBody.toString('utf8'));
        if (ping.error) {
          console.log(`✗ job ${ping.job_id} failed:`, JSON.stringify(ping.error));
          return;
        }
        const job = await fetchJob(ping.job_id);
        if (job) console.log(`✓ job ${ping.job_id} → ${job.status} · cost ${job.cost?.credits ?? '0'} µcredit`);
        else console.log(`✓ job ${ping.job_id} succeeded (set ACTIONOW_BASE_URL + ACTIONOW_API_KEY to fetch output)`);
      });
    })
    .listen(port, () => console.error(`listening for Actionow webhooks on :${port}/webhooks/actionow`));
} else {
  // library mode: verify a captured delivery from a file
  const [file, sig] = process.argv.slice(2);
  if (!file || !sig) { console.error('usage: node verify-webhook.mjs <rawBodyFile> <hexSignature>  |  --serve'); process.exit(2); }
  const result = verifyWebhookSignature(readFileSync(file), sig, SECRET);
  console.log(JSON.stringify(result));
  process.exit(result.valid ? 0 : 1);
}
