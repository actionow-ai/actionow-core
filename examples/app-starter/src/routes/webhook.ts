import type { Request, Response } from 'express';

import { config } from '../config.js';
import { dataClient, verifyWebhookSignature } from '../core-kit/index.js';

/**
 * POST /webhooks/actionow — mount with express.raw({ type: 'application/json' }).
 * The delivery body is a minimal ping: { job_id } on success, { job_id, error } on
 * failure. Verify over RAW bytes, ack fast, then fetch the job for the real result.
 */
export function webhookRoute() {
  return async (req: Request, res: Response): Promise<void> => {
    const raw = req.body as Buffer;
    const result = verifyWebhookSignature(
      raw,
      req.header('X-Actionow-Signature'),
      config.webhookSecret(),
    );
    if (!result.valid) {
      res.status(401).json({ error: result.reason });
      return;
    }
    res.sendStatus(200); // ack fast — Actionow marks the delivery sent

    const ping = JSON.parse(raw.toString('utf8')) as { job_id: string; error?: unknown };
    if (ping.error) return; // failed — record it out of band
    // Body is minimal; fetch the real result with the proxy ak_ (must be TENANT-LEVEL
    // so it can read any end-user's job — a subject-scoped key 404s on foreign jobs).
    const { data } = await dataClient(config.baseUrl(), config.proxyApiKey()).GET('/v1/jobs/{id}', {
      params: { path: { id: ping.job_id } },
    });
    if (!data) {
      console.error(
        `job ${ping.job_id} not readable — is ACTIONOW_PROXY_API_KEY a tenant-level key?`,
      );
      return;
    }
    void data; // resolve output file_ids, notify the user, etc.
  };
}
