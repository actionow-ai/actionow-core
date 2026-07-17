// packages/engine/src/gateway/task-view.ts
//
// model-supply-greenfield 批次4 slice4 — TaskRow → the EXTERNAL Task object
// (§5 API 形状; wire schema = contracts gateway-wire.ts gatewayTaskViewSchema).
// Hoisted from apps/api/src/gateway/task-view.ts (slice3) so the §7.6 webhook
// event envelope (完整 Task 体, task-webhook.ts) and the API face project the
// SAME external shape from one source; the api module now re-exports from
// here. Pure projection: six-state status verbatim, unix-second timestamps,
// the §9.4 artifact expiry as `expires_at`, and the addressed model's external
// name recovered from the `inputs` IR snapshot. Internal columns (substate,
// lease, hold bookkeeping, fingerprints) NEVER leak.
import type {
  GatewayTaskEventView,
  GatewayTaskView,
  GatewayUsageView,
  Operation,
  TaskStatus,
} from '@actionow/contracts';
import type { TaskEventRow, TaskRow } from '@actionow/db';

/** Unix seconds of a nullable timestamp. */
function unix(ts: Date | null): number | null {
  return ts === null ? null : Math.floor(ts.getTime() / 1000);
}

/** The addressed model's external name from the create-time IR snapshot. */
function modelOf(row: TaskRow): string | null {
  const model = (row.inputs as Record<string, unknown> | null)?.model;
  return typeof model === 'string' ? model : null;
}

function usageOf(row: TaskRow): GatewayUsageView | null {
  if (row.usage === null) return null;
  return {
    metrics: row.usage.metrics,
    billing_dims: row.usage.billingDims,
    estimated: row.usage.estimated,
  };
}

/** Render one task row as the external Task object (§5). */
export function toTaskView(row: TaskRow): GatewayTaskView {
  return {
    id: row.id,
    object: 'task',
    type: row.operation as Operation,
    model: modelOf(row),
    status: row.status as TaskStatus,
    progress: row.progress,
    output: row.output ?? null,
    usage: usageOf(row),
    error: row.error,
    served_by: row.offeringId !== null ? { offering_id: row.offeringId } : null,
    created: unix(row.createdAt) ?? 0,
    started: unix(row.startedAt),
    finished: unix(row.finishedAt),
    expires_at: unix(row.artifactExpiresAt),
  };
}

/** Render one task_events row for the SSE progress stream (§7.1 seq order). */
export function toTaskEventView(row: TaskEventRow): GatewayTaskEventView {
  return {
    seq: row.seq,
    from_status: (row.fromStatus as TaskStatus | null) ?? null,
    to_status: row.toStatus as TaskStatus,
    payload: row.payload ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
