export const QUEUE_NAMES = [
  'job-exec',
  'webhook-outbox',
  'hold-reaper',
  'token-refresh',
  'poll-upstream',
  'relay-trace-reaper',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
