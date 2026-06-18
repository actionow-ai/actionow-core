import type { DispatchSummary } from '@actionow/engine';
import { WebhookDispatcher } from '@actionow/engine';
import { assertEgressAllowed } from '@actionow/infra';

import type { WorkerRuntime } from '../runtime.js';

/**
 * Build the `webhook-outbox` processor: drain due `webhook_outbox` rows,
 * POSTing each with its HMAC signature and rescheduling failures with backoff
 * (or dead-lettering). Pure over the injected runtime; returns the dispatch
 * summary for logging/metrics.
 *
 * Webhook signing secrets resolve through the same stub resolver as channel
 * credentials, keyed by the webhook url (`SECRET_<url>`). Absent → unsigned.
 */
export function createWebhookOutboxProcessor(
  runtime: WorkerRuntime,
): () => Promise<DispatchSummary> {
  const allowPrivateTargets = runtime.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === true;
  const dispatcher = new WebhookDispatcher({
    resolveSecret: (url: string) => runtime.resolveSecret(url),
    // SSRF egress guard, secure-by-default. Self-hosted/dev setups that deliver
    // to a private/loopback callback opt in via WEBHOOK_ALLOW_PRIVATE_TARGETS.
    assertEgressAllowed: (url: string) => assertEgressAllowed(url, { allowPrivateTargets }),
  });
  return (): Promise<DispatchSummary> =>
    dispatcher.dispatchDue(runtime.db, runtime.http, new Date());
}
