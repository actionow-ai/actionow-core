export const QUEUE_NAMES = ['job-exec', 'webhook-outbox', 'hold-reaper', 'poll-upstream'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
