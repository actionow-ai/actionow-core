import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify the HMAC signature on an INBOUND webhook that Actionow core delivered to
 * your app (the async job-done callback you register as `callback_url`).
 *
 * Core's outbound webhook dispatcher signs every delivery: it computes
 * `HMAC-SHA256(secret, rawBody)` as lowercase hex and sends it in the
 * `X-Actionow-Signature` header (see `packages/engine/src/webhook.ts`,
 * `signPayload` + `SIGNATURE_HEADER`). The `secret` is resolved per webhook URL
 * on the core side; you configure the matching secret in your app and pass it
 * here. If core could not resolve a secret for the URL, the delivery is sent
 * UNSIGNED (no header) — so an absent signature means "unsigned", which this
 * helper reports distinctly from "wrong signature".
 *
 * IMPORTANT — verify over the RAW request bytes, not a re-serialized object.
 * The HMAC is computed over the exact `JSON.stringify(payload)` core sent; if you
 * parse the JSON and re-stringify it, key order / whitespace can differ and the
 * digest will not match. In Express, capture the raw body (e.g. the
 * `verify` option of `express.json`, or `express.raw`). The same byte-exact rule
 * is why core itself verifies its INBOUND provider callbacks over `req.rawBody`
 * (`apps/api/src/callbacks/callbacks.service.ts`).
 *
 * Note on the scheme: the LEGACY job-path outbound webhooks are signed with
 * body-only HMAC-SHA256 (no timestamp header), so this verifier intentionally
 * does NOT require a timestamp. The NEW task-center webhooks (model-supply
 * greenfield §7.6 — task events from /v1/videos|audio|tasks creates) use an
 * HMAC **with timestamp** instead: verify those with
 * {@link verifyTaskWebhookSignature} below. Both verifiers coexist while the
 * two worlds run side by side (双面并存).
 */

/** The header core sends the HMAC-SHA256 hex signature in. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Actionow-Signature';

/** The outcome of {@link verifyWebhookSignature}. */
export type WebhookVerification =
  | { valid: true }
  /** No signature header was present — core delivered the webhook unsigned. */
  | { valid: false; reason: 'missing-signature' }
  /** A signature was present but did not match the expected digest. */
  | { valid: false; reason: 'invalid-signature' };

/** Normalize a header that may arrive as `string | string[] | undefined` (Node) to the first value. */
function firstHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}

/**
 * Verify a webhook delivery's HMAC signature in constant time.
 *
 * @param rawBody - The EXACT request body bytes core POSTed (string or Buffer).
 *   Do not pass a re-serialized object — see the module note above.
 * @param signatureHeader - The `X-Actionow-Signature` header value (a hex digest),
 *   or `undefined`/`string[]` (Node's raw header shape) when absent.
 * @param secret - The shared signing secret you configured for this webhook URL.
 * @returns A discriminated result; `{ valid: true }` only when the recomputed
 *   digest matches. Never throws on a bad/short signature.
 *
 * @example
 * app.post('/webhooks/actionow', express.raw({ type: 'application/json' }), (req, res) => {
 *   const result = verifyWebhookSignature(
 *     req.body, // a Buffer (express.raw)
 *     req.header('X-Actionow-Signature'),
 *     process.env.ACTIONOW_WEBHOOK_SECRET!,
 *   );
 *   if (!result.valid) return res.status(401).json({ error: result.reason });
 *   const event = JSON.parse(req.body.toString('utf8'));
 *   // ... act on the job-done event, then 2xx so core marks the delivery `sent`.
 *   res.sendStatus(200);
 * });
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string,
): WebhookVerification {
  const provided = firstHeaderValue(signatureHeader);
  if (provided === undefined || provided.length === 0) {
    return { valid: false, reason: 'missing-signature' };
  }

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret).update(body).digest('hex');

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // A length mismatch would make `timingSafeEqual` throw; guard it (and a
  // differing length is by definition a non-match).
  if (a.length !== b.length) return { valid: false, reason: 'invalid-signature' };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'invalid-signature' };
}

// --- NEW task-center webhooks (model-supply greenfield §7.6) -----------------------------
//
// The NEW gateway's task webhooks (the `callback_url` you pass on
// `POST /v1/videos/generations` / `/v1/audio/music` / `/v1/tasks`) are signed
// with an HMAC **with timestamp** — a different scheme from the legacy
// body-only signature above:
//
//   X-Actionow-Signature: t=<unix seconds>,v1=<hex(HMAC-SHA256(secret, t + "." + rawBody))>
//   X-Actionow-Event:     task.running | task.progress | task.succeeded |
//                         task.failed | task.canceled
//
// The signing `secret` is TENANT-LEVEL configuration on the core side
// (`tenant.config.webhook_secret`); each delivery attempt is re-signed fresh,
// so the default ±300s replay window comfortably covers the retry ladder.
// The envelope body is `{ evt_id, event_type, created_at, task }` — dedupe on
// `evt_id` (core retries deliveries; the SAME logical event always carries the
// SAME evt_id). This mirrors core's reference implementation
// (`packages/engine/src/gateway/task-webhook.ts`, verifyTaskWebhookSignature).

/** The header carrying the timestamped task-webhook signature (`t=<ts>,v1=<hex>`). */
export const TASK_WEBHOOK_SIGNATURE_HEADER = 'X-Actionow-Signature';
/** The header naming the task-webhook envelope's event type. */
export const TASK_WEBHOOK_EVENT_HEADER = 'X-Actionow-Event';
/** Default replay-window tolerance (seconds) for {@link verifyTaskWebhookSignature}. */
export const TASK_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The outcome of {@link verifyTaskWebhookSignature}. */
export type TaskWebhookVerification =
  /** Signature verified; `timestamp` is the signer's unix-seconds instant. */
  | { valid: true; timestamp: number }
  /** No signature header — core had no tenant webhook secret configured. */
  | { valid: false; reason: 'missing-signature' }
  /** The header is not `t=<digits>,v1=<hex>`. */
  | { valid: false; reason: 'malformed-signature' }
  /** The timestamp is outside the replay window (default ±300s). */
  | { valid: false; reason: 'stale-timestamp' }
  /** Shape and freshness OK but the digest does not match. */
  | { valid: false; reason: 'invalid-signature' };

/**
 * Verify a NEW-gateway task-webhook delivery (timestamped HMAC, §7.6) in
 * constant time.
 *
 * @param rawBody - The EXACT request body bytes core POSTed (string or Buffer).
 *   Never a re-serialized object — see the byte-exact note on
 *   {@link verifyWebhookSignature}.
 * @param signatureHeader - The `X-Actionow-Signature` value (`t=...,v1=...`).
 * @param secret - The tenant webhook secret configured on the core side.
 * @param options - `nowSeconds` (test clock) and `toleranceSeconds`
 *   (default {@link TASK_WEBHOOK_TOLERANCE_SECONDS}).
 *
 * @example
 * app.post('/webhooks/actionow-tasks', express.raw({ type: 'application/json' }), (req, res) => {
 *   const result = verifyTaskWebhookSignature(
 *     req.body,
 *     req.header('X-Actionow-Signature'),
 *     process.env.ACTIONOW_WEBHOOK_SECRET!,
 *   );
 *   if (!result.valid) return res.status(401).json({ error: result.reason });
 *   const event = JSON.parse(req.body.toString('utf8'));
 *   // dedupe on event.evt_id, then act on event.task (the full Task body)
 *   res.sendStatus(200);
 * });
 */
export function verifyTaskWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): TaskWebhookVerification {
  const provided = firstHeaderValue(signatureHeader);
  if (provided === undefined || provided.length === 0) {
    return { valid: false, reason: 'missing-signature' };
  }
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(provided.trim());
  if (match === null) return { valid: false, reason: 'malformed-signature' };

  const ts = Number(match[1]);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? TASK_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > tolerance) {
    return { valid: false, reason: 'stale-timestamp' };
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret)
    .update(`${String(ts)}.${body}`)
    .digest('hex');
  const a = Buffer.from(match[2] ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { valid: false, reason: 'invalid-signature' };
  return timingSafeEqual(a, b)
    ? { valid: true, timestamp: ts }
    : { valid: false, reason: 'invalid-signature' };
}
