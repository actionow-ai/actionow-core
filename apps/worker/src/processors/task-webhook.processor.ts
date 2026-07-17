// apps/worker/src/processors/task-webhook.processor.ts
//
// model-supply-greenfield 批次4 slice4 — the §7.6 downstream webhook delivery
// sweep over the NEW `webhook_deliveries` table (the old webhook-outbox stays
// untouched, 双面并存): drain due rows, POST each event envelope with a FRESH
// `t=<ts>,v1=<hmac>` signature, reschedule failures on the FIXED five-slot
// ladder (5s/30s/2m/10m/1h), dead-letter past it.
//
// The signing secret is TENANT-LEVEL configuration (§7.6 — secret 不随请求传):
// delivery row → task row → tenant.config.webhook_secret. Absent → unsigned
// delivery (the receiver's evt_id idempotency still holds).
import { getTaskById, getTenantWebhookSecret, type WebhookDeliveryRow } from '@actionow/db';
import type { TaskWebhookDispatchSummary } from '@actionow/engine';
import { TaskWebhookDispatcher } from '@actionow/engine';
import { assertEgressAllowed } from '@actionow/infra';

import type { WorkerRuntime } from '../runtime.js';

/** Build the `task-webhook` processor (repeatable BullMQ sweep, ~every 10s). */
export function createTaskWebhookProcessor(
  runtime: WorkerRuntime,
): () => Promise<TaskWebhookDispatchSummary> {
  const allowPrivateTargets = runtime.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === true;
  const dispatcher = new TaskWebhookDispatcher({
    // §7.6 tenant-level secret: delivery → task → tenant config bag.
    resolveSecret: async (row: WebhookDeliveryRow): Promise<string | undefined> => {
      const task = await getTaskById(runtime.db, row.taskId);
      if (task === undefined) return undefined;
      return getTenantWebhookSecret(runtime.db, task.tenantId);
    },
    // SSRF egress guard, secure-by-default; self-hosted/dev setups delivering
    // to private/loopback callbacks opt in via WEBHOOK_ALLOW_PRIVATE_TARGETS.
    assertEgressAllowed: (url: string) => assertEgressAllowed(url, { allowPrivateTargets }),
  });
  return (): Promise<TaskWebhookDispatchSummary> =>
    dispatcher.dispatchDue(runtime.db, runtime.http, new Date());
}
