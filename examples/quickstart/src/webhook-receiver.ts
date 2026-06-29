import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@actionow/sdk/webhook';

/**
 * Webhook receiver for the async job-done callback (the PUSH alternative to
 * polling — see media.ts `submitImageWithCallback`). When you submit a run with
 * `callback_url`, core POSTs the terminal job to that URL and signs it with
 * HMAC-SHA256 over the RAW body in the `X-Actionow-Signature` header.
 *
 * CONFIRMED: core's outbound webhooks ARE signed (see
 * `packages/engine/src/webhook.ts` — `signPayload` + the `X-Actionow-Signature`
 * header). The shared signing secret is resolved per webhook URL on the core
 * side; configure the matching secret in your app and pass it here.
 *
 * Two hard rules:
 *   1. Verify over the EXACT received bytes. Do NOT parse-then-restringify before
 *      verifying — key order/whitespace would differ and the HMAC would not match.
 *   2. Return 2xx promptly so core marks the delivery `sent`. A non-2xx (or no
 *      response) makes core retry with exponential backoff, then dead-letter.
 */

/** The async job payload core delivers (the terminal job, mirrors the `RunJobView`). */
export interface JobWebhookPayload {
  job_id: string;
  status: 'succeeded' | 'failed' | 'canceled';
  resource_id: string;
  output?: unknown;
  error?: unknown;
  cost?: { credits: string } | null;
}

/** Outcome of handling a delivery — map it to an HTTP status in your framework glue. */
export type WebhookOutcome =
  | { ok: true; payload: JobWebhookPayload }
  | { ok: false; httpStatus: 401; reason: string };

/**
 * Framework-agnostic handler: feed it the raw body bytes and the request headers.
 * Returns whether the delivery was authentic and, if so, the parsed payload.
 *
 * Wire it into your server (Express shown):
 *
 *   app.post(
 *     '/webhooks/actionow',
 *     express.raw({ type: 'application/json' }), // keep the RAW body
 *     (req, res) => {
 *       const result = handleJobWebhook(
 *         req.body,                                 // Buffer
 *         req.headers,                              // includes x-actionow-signature
 *         process.env.ACTIONOW_WEBHOOK_SECRET!,
 *       );
 *       if (!result.ok) return res.status(result.httpStatus).json({ error: result.reason });
 *       // ... update your app DB: mark the request done, resolve file_ids, notify the user.
 *       res.sendStatus(200);
 *     },
 *   );
 */
export function handleJobWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): WebhookOutcome {
  // Header lookup is case-insensitive on the wire; Node lowercases header keys.
  const signature = headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
  const verification = verifyWebhookSignature(rawBody, signature, secret);
  if (!verification.valid) {
    return { ok: false, httpStatus: 401, reason: verification.reason };
  }

  const payload = JSON.parse(rawBody.toString('utf8')) as JobWebhookPayload;
  return { ok: true, payload };
}
