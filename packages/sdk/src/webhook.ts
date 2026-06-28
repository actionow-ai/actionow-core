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
 * Note on the scheme: core's OUTBOUND webhooks are signed with body-only
 * HMAC-SHA256 (no timestamp header today), so this verifier intentionally does
 * NOT require a timestamp. Core's INBOUND provider-callback path DOES support an
 * optional `X-Actionow-Timestamp` replay window; if a future core release adds
 * a timestamp to OUTBOUND webhooks, extend this helper to match.
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
