# 06 · Webhooks (task event callbacks)

The push alternative to polling: create a task with a `callback_url`, and Actionow POSTs **signed event envelopes** to it as the task progresses and finishes. This is the **outbound** gateway→your-app delivery (distinct from the inbound provider ingress `POST /v1/gateway/callbacks/:offeringId`, which _you never implement_).

## Subscribing

```jsonc
POST /v1/tasks   (or /v1/videos/generations, /v1/audio/music)
{ "type": "video.generation", "model": "seedance-pro", "prompt": "…",
  "callback_url": "https://you.example/webhooks/actionow-tasks" }
// → 202 { id, object:"task", status:"pending", … }
```

Persist the returned task `id` against your app's request row; incoming envelopes also carry the full task so correlation is one lookup.

> **`callback_url` must be a publicly-reachable `http(s)` URL.** An egress guard rejects private / loopback / link-local / reserved addresses (`http://localhost`, `127.0.0.1`, `10.x`, `192.168.x`, …) and non-`http(s)` schemes — a webhook to a local dev server silently never arrives. For local testing, expose your receiver through a tunnel (ngrok, Cloudflare Tunnel, etc.), or have the gateway operator allow private targets in dev.

## What the delivery contains — the event envelope

Unlike the legacy job ping, a task webhook delivers the **FULL Task object** inside a typed envelope:

```jsonc
{
  "evt_id": "…",                 // DETERMINISTIC per logical event — your dedupe key
  "event_type": "task.succeeded", // task.running | task.progress | task.succeeded | task.failed | task.canceled
  "created_at": "2026-07-13T09:00:00.000Z",
  "task": { "id": "…", "object": "task", "status": "succeeded", "output": {…}, "usage": {…}, … }
}
```

Headers on every delivery:

- `X-Actionow-Event: <event_type>` — routing convenience.
- `X-Actionow-Signature: t=<unix seconds>,v1=<hex>` — the **timestamped** HMAC (below).
- `Content-Type: application/json`.

Terminal events (`task.succeeded` / `task.failed` / `task.canceled`) carry the final output/usage/error in `task` — usually no follow-up fetch is needed; `GET /v1/tasks/:id` remains the authoritative read if you want one.

## Verifying — timestamped HMAC over the RAW bytes

The signature scheme is `v1 = HMAC-SHA256(secret, "<t>.<rawBody>")` where `t` is the unix-seconds timestamp from the header. Verify over the **exact bytes** received (never `JSON.parse`-then-restringify), check `t` against a replay window (default tolerance ±300 s — each retry attempt is re-signed fresh, so a tight window is safe), and compare digests constant-time.

The signing **secret is tenant-level configuration** on the core side (ask your platform operator to set your tenant's webhook secret; it is NOT passed per request). No secret configured → deliveries arrive **unsigned** (no header) — decide deliberately whether to accept that; for anything that mutates state or money, **fail closed**.

### With `@actionow/sdk`

```js
import express from 'express';
import { verifyTaskWebhookSignature } from '@actionow/sdk/webhook';

app.post('/webhooks/actionow-tasks', express.raw({ type: 'application/json' }), (req, res) => {
  const result = verifyTaskWebhookSignature(
    req.body, // Buffer — the raw bytes, NOT parsed
    req.header('X-Actionow-Signature'),
    process.env.ACTIONOW_WEBHOOK_SECRET,
  );
  if (!result.valid) return res.status(401).json({ error: result.reason });
  // reasons: 'missing-signature' | 'malformed-signature' | 'stale-timestamp' | 'invalid-signature'

  const evt = JSON.parse(req.body.toString('utf8')); // { evt_id, event_type, created_at, task }
  res.sendStatus(200); // ack FAST (2xx), do the rest out of band

  if (alreadyProcessed(evt.evt_id)) return; // retries reuse the SAME evt_id — dedupe here
  if (evt.event_type === 'task.succeeded') deliverToUser(evt.task.output);
  else if (evt.event_type === 'task.failed') markFailed(evt.task.id, evt.task.error);
});
```

### Without the SDK (any language)

```js
import crypto from 'node:crypto';
function verify(rawBody, header, secret, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(header ?? '').trim());
  if (!header) return { valid: false, reason: 'missing-signature' };
  if (!m) return { valid: false, reason: 'malformed-signature' };
  const ts = Number(m[1]);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec)
    return { valid: false, reason: 'stale-timestamp' };
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(m[2]),
    b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { valid: true, timestamp: ts } : { valid: false, reason: 'invalid-signature' };
}
```

Standalone verifier + a tiny raw-body receiver you can run: [scripts/verify-webhook.mjs](../scripts/verify-webhook.mjs).

## Delivery & retry semantics to design around

- On a `2xx` from you the delivery is marked delivered; on non-2xx / timeout it retries on a **fixed five-slot backoff ladder — 5s / 30s / 2m / 10m / 1h** — then dead-letters permanently (no replay API; dead-lettering does **not** affect billing — the task already settled). Sweep `GET /v1/tasks?status=succeeded` as a backstop.
- Deliveries can arrive **more than once** and out of order — the SAME logical event always carries the SAME `evt_id`; make your handler idempotent on it, and treat a terminal event as final even if a late `task.progress` arrives afterwards.
- Return `2xx` fast; do slow work (downloading artifacts, notifying users) out of band so a slow handler doesn't consume retry budget.
- **Canceling via `POST /v1/tasks/:id/cancel` DOES emit a `task.canceled` envelope** (the terminal transition is engine-side).

## Legacy job webhooks (deprecated `/v1/run` face)

The old face's deliveries are different in every way that matters: a minimal ping body (`{ job_id }`, plus `error`/`status` on failure — NOT the result), signed with a **body-only** HMAC (no timestamp) in the same `X-Actionow-Signature` header, secret resolved per-URL from the gateway environment. Verify those with `verifyWebhookSignature` (not `verifyTaskWebhookSignature`) and fetch `GET /v1/jobs/:id` for the result. This path disappears with the migration window — plan its removal.
