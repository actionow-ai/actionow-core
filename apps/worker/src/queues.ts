export const QUEUE_NAMES = [
  'job-exec',
  'webhook-outbox',
  'hold-reaper',
  'token-refresh',
  'poll-upstream',
  'relay-trace-reaper',
  'file-lifecycle-reaper',
  // model-supply-greenfield 批次4 slice4 — the NEW-WORLD task-center sweeps
  // (双面并存: the old job-path queues above are untouched).
  'task-poll',
  'task-reaper',
  'task-webhook',
  'task-events-reaper',
  // 批次4 slice5 — §9.4 signed-track artifact lifecycle sweep.
  'artifact-reaper',
  // 批次5 slice4 — §9.2 官方渠道日对账比对器 (daily official-channel reconcile).
  'reconcile-daily',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
