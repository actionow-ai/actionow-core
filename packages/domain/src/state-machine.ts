import type { JobEvent, JobStatus } from '@actionow/contracts';

import { DomainError } from './errors.js';

/**
 * Job lifecycle transition table (spec §5).
 *
 * - `queued --start--> running`
 * - `queued | running --succeed--> succeeded`
 * - `queued | running --fail--> failed`
 * - `queued | running --cancel--> canceled`
 *
 * Terminal states (`succeeded`, `failed`, `canceled`) have no outgoing edges.
 */
const TRANSITIONS: Record<JobStatus, Partial<Record<JobEvent, JobStatus>>> = {
  queued: {
    start: 'running',
    succeed: 'succeeded',
    fail: 'failed',
    cancel: 'canceled',
  },
  running: {
    succeed: 'succeeded',
    fail: 'failed',
    cancel: 'canceled',
  },
  succeeded: {},
  failed: {},
  canceled: {},
};

/**
 * Apply `event` to `current`, returning the next status.
 * Throws `DomainError('invalid_transition')` if the edge is not in the §5 table.
 */
export function transition(current: JobStatus, event: JobEvent): JobStatus {
  const next = TRANSITIONS[current][event];
  if (next === undefined) {
    throw new DomainError('invalid_transition', `cannot ${event} a job in status "${current}"`);
  }
  return next;
}

/** True when `status` is terminal (no outgoing transitions). */
export function isTerminal(status: JobStatus): boolean {
  return Object.keys(TRANSITIONS[status]).length === 0;
}
