import { z } from 'zod';

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusSchema = z.enum(JOB_STATUSES);

export const JOB_EVENTS = ['start', 'succeed', 'fail', 'cancel'] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];
