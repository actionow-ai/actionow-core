import { type DataPlaneClient, dataPlaneClient } from './client.js';

import { submitAndWait } from '@actionow/sdk';

/**
 * Async media generation. The generic data-plane entrypoint is
 * `POST /v1/run/:resourceId` — it submits a job and (for async resources) returns
 * a `queued` job you poll at `GET /v1/jobs/:id`. The SDK's `submitAndWait` runs
 * that submit→poll loop for you. This is the recommended path for image/video/
 * audio generation because it never holds an HTTP request open for minutes.
 *
 * `resourceId` identifies the resource to run (e.g. an image-relay resource);
 * discover the ones available to a key via `GET /v1/resources`. `inputs` is the
 * resource's io_schema payload (a `file` input carries a `file_id` — see files.ts).
 *
 * The job carries the END-USER's `ak_…` key, so the spend lands on that subject's
 * wallet. (Also pass `end_user: subjectId` to tag usage explicitly even when the
 * key itself is tenant-wide.)
 */
export async function generateImage(
  baseUrl: string,
  apiKey: string,
  resourceId: string,
  prompt: string,
  subjectId?: string,
): Promise<unknown> {
  const client: DataPlaneClient = dataPlaneClient(baseUrl, apiKey);

  const job = await submitAndWait(
    client,
    resourceId,
    {
      inputs: { prompt },
      ...(subjectId === undefined ? {} : { end_user: subjectId }),
    },
    { pollMs: 1500, timeoutMs: 180_000 },
  );

  if (job.status !== 'succeeded') {
    throw new Error(`image job ${job.job_id} ended ${job.status}: ${JSON.stringify(job.error)}`);
  }
  // `output` is resource-shaped (e.g. `{ images: [{ file_id }] }` or `{ url }`);
  // resolve any returned `file_id` to a download URL with files.ts.
  return job.output;
}

/**
 * The PUSH alternative to polling: submit with a `callback_url` so core POSTs a
 * signed webhook to your receiver when the job is terminal — no polling at all.
 * Verify the delivery with `verifyWebhookSignature` (see webhook-receiver.ts).
 *
 * This uses the typed client directly (not `submitAndWait`, which forces poll
 * mode) so we can set `exec_mode: 'async-callback'` + `callback_url`.
 */
export async function submitImageWithCallback(
  baseUrl: string,
  apiKey: string,
  resourceId: string,
  prompt: string,
  callbackUrl: string,
): Promise<string> {
  const client: DataPlaneClient = dataPlaneClient(baseUrl, apiKey);

  const { data, error, response } = await client.POST('/v1/run/{resourceId}', {
    params: { path: { resourceId } },
    body: { inputs: { prompt }, exec_mode: 'async-callback', callback_url: callbackUrl },
  });
  if (error !== undefined) {
    throw new Error(`submit failed: ${String(response.status)} ${JSON.stringify(error)}`);
  }
  // Persist `job_id` against your app's request row so the webhook can be correlated.
  return data.job_id;
}
