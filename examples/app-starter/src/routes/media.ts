import type { Request, Response } from 'express';

import { config } from '../config.js';
import { dataClient, submitAndWait } from '../core-kit/index.js';
import { userStore } from '../store/users.js';

/**
 * POST /api/media { userId, resourceId, inputs, webhook? }
 * Default: submit /v1/run and POLL to terminal. With `webhook:true` and PUBLIC_BASE_URL
 * set: submit async-callback so the result arrives at /webhooks/actionow instead.
 * Attribution is via the user's subject-scoped ak_ (so no end_user needed).
 */
export function mediaRoute() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId, resourceId, inputs, webhook } = req.body ?? {};
    const row = userStore.get(String(userId));
    if (!row) {
      res.status(404).json({ error: 'unknown user' });
      return;
    }
    const client = dataClient(config.baseUrl(), row.apiKey);
    const publicUrl = config.publicBaseUrl();
    if (webhook && publicUrl) {
      const { data, error } = await client.POST('/v1/run/{resourceId}', {
        params: { path: { resourceId: String(resourceId) } },
        body: {
          inputs,
          exec_mode: 'async-callback',
          callback_url: `${publicUrl}/webhooks/actionow`,
        },
      });
      if (error) {
        res.status(502).json({ error });
        return;
      }
      res.json(data); // { job_id, status:'queued' } — the webhook fires on completion
      return;
    }
    const job = await submitAndWait(
      client,
      String(resourceId),
      { inputs },
      { pollMs: 1500, timeoutMs: 180_000 },
    );
    res.json(job); // resolve any output file_id via /v1/files/:id/url
  };
}
