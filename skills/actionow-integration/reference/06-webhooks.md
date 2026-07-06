# 06 · Webhooks (async job callbacks)

The push alternative to polling: submit a run with a `callback_url`, and Actionow POSTs a signed **ping** to it when the job finishes. This is the **outbound** gateway→your-app delivery (distinct from the inbound provider ingress `POST /v1/callbacks/:provider`, which _you never implement_).

## Submitting for a callback

```jsonc
POST /v1/run/:resourceId
{ "inputs": { … }, "exec_mode": "async-callback", "callback_url": "https://you.example/webhooks/actionow" }
// → 202 { job_id, status:"queued" }
```

Persist the returned `job_id` against your app's request row so the incoming webhook can be correlated back to the user.

> **`callback_url` must be a publicly-reachable `http(s)` URL.** An egress guard rejects private / loopback / link-local / reserved addresses (`http://localhost`, `127.0.0.1`, `10.x`, `192.168.x`, …) and non-`http(s)` schemes, and **dead-letters the delivery immediately** — so a webhook to a local dev server silently never arrives. For local testing, expose your receiver through a tunnel (ngrok, Cloudflare Tunnel, etc.). If you or your platform team operate the gateway, you can instead set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` on the worker to allow localhost/private callback targets in dev — tunnels are only required against a gateway you don't control.

> **Webhooks fire for _any_ run that carries `callback_url`** — async-poll and even blocking/stream runs — not just `exec_mode: "async-callback"`. Deliveries are sent with `Content-Type: application/json` and carry no identifying header besides `X-Actionow-Signature`.

## What the delivery actually contains (read this)

The delivered body is **minimal** — it is a _"job N reached a terminal state"_ ping, **not** the job result:

| Outcome              | Body                                                           |
| -------------------- | -------------------------------------------------------------- |
| Success              | `{ "job_id": "<uuid>" }`                                       |
| Failure              | `{ "job_id": "<uuid>", "error": { … } }`                       |
| Hold-expiry / reaped | `{ "job_id": "<uuid>", "status": "canceled", "error": { … } }` |

There is **no** `status` / `output` / `usage` / `cost` on the success body. Distinguish success from failure by the **presence of an `error` key**. To get the result, **fetch the job**: `GET /v1/jobs/:job_id` with your data-plane `ak_…` key → the full `{ status, output, usage, cost, … }`, then resolve any `output` `file_id` via `GET /v1/files/:id/url`.

Header on every delivery: `X-Actionow-Signature: <lowercase hex>` = `HMAC-SHA256(secret, rawBody)`. On a `2xx` from you the delivery is marked `sent`; on non-2xx / timeout it is retried with exponential backoff — **5 total attempts by default** (~1s / 2s / 4s / 8s between them) — then dead-lettered **permanently** (there is no replay API; dead-lettering does **not** affect billing — the job already settled). Sweep for missed jobs via `GET /v1/jobs` as a backstop.

## Verifying — over the RAW bytes

The #1 mistake is verifying a re-serialized body. HMAC is over the **exact bytes** Actionow sent; `JSON.parse` + `JSON.stringify` reorders/reformats and the signature won't match. Read the raw body, verify, _then_ parse.

### With `@actionow/sdk`

```js
import express from 'express';
import { verifyWebhookSignature } from '@actionow/sdk/webhook'; // WEBHOOK_SIGNATURE_HEADER === 'X-Actionow-Signature'

app.post('/webhooks/actionow', express.raw({ type: 'application/json' }), async (req, res) => {
  const result = verifyWebhookSignature(
    req.body, // Buffer — the raw bytes, NOT parsed
    req.header('X-Actionow-Signature'),
    process.env.ACTIONOW_WEBHOOK_SECRET,
  );
  if (!result.valid) return res.status(401).json({ error: result.reason }); // 'missing-signature' | 'invalid-signature'

  const ping = JSON.parse(req.body.toString('utf8')); // { job_id, error? }
  res.sendStatus(200); // ack FAST (2xx), do the rest out of band

  // correlate + fetch the real result
  if (ping.error) return markFailed(ping.job_id, ping.error);
  const job = await fetch(`${BASE}/v1/jobs/${ping.job_id}`, {
    headers: { authorization: `Bearer ${AK}` },
  }).then((r) => r.json());
  // job.status / job.output / job.cost.credits (µcredit string) — resolve file_ids via /v1/files/:id/url
});
```

### Without the SDK (any language)

```js
import crypto from 'node:crypto';
function verify(rawBody, header, secret) {
  if (!header) return { valid: false, reason: 'missing-signature' };
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected),
    b = Buffer.from(String(header));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { valid: true } : { valid: false, reason: 'invalid-signature' };
}
```

Standalone verifier + a tiny raw-body receiver you can run: [scripts/verify-webhook.mjs](../scripts/verify-webhook.mjs).

## Failing closed

The signing secret is resolved per webhook URL on the Actionow side. If it can't resolve one, the delivery is sent **unsigned** (no header) — which surfaces distinctly as `missing-signature`. Decide deliberately whether to accept unsigned deliveries; for anything that mutates state or money, **fail closed** (reject `missing-signature`).

How the gateway provisions the secret: the worker resolves it as `SECRET_<callback-url, non-alphanumerics → _, upper-cased>` from its environment (or a credential row). Without that entry on the gateway side, pings are delivered unsigned.

## Semantics to design around

- Deliveries can arrive **more than once** (retries) — make your handler idempotent on `job_id`.
- There is currently **no timestamp** on the outbound signature, so there's no built-in replay window; rely on `job_id` idempotency. (The separate inbound `POST /v1/callbacks/:provider` ingress _does_ use a timestamp window, but that path is provider→gateway and never something your app builds.)
- Return `2xx` fast; do slow work (fetching the job, downloading a `file_id`, notifying the user) out of band so Actionow doesn't retry a delivery you actually received.
- **Canceling a job yourself (`POST /v1/jobs/:id/cancel`) does NOT produce a webhook.** Only engine-side terminal transitions (settle, fail, hold-expiry reap) deliver — reconcile externally-canceled jobs via `GET /v1/jobs/:id`.
