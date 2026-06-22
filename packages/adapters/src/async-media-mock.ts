import { randomUUID } from 'node:crypto';

import type {
  CallbackResult,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UpstreamStatus,
  UsageVector,
} from '@actionow/contracts';

import { inferModality, toMediaResult } from './async-media.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'async-media-mock';
const DEFAULT_READY_AFTER_POLLS = 1;
const MOCK_VIDEO_DURATION_SECONDS = 5;

export interface AsyncMediaMockOptions {
  /** Number of polls before a job transitions to `succeeded` (default 1). */
  readyAfterPolls?: number;
}

interface JobState {
  modality: string;
  polls: number;
}

const VALID_STATUSES: readonly UpstreamStatus[] = ['running', 'succeeded', 'failed'];

function asRecord(x: unknown): Record<string, unknown> | undefined {
  if (typeof x === 'object' && x !== null && !Array.isArray(x)) {
    return x as Record<string, unknown>;
  }
  return undefined;
}

/** Narrow an arbitrary value to an {@link UpstreamStatus}, defaulting to `failed`. */
function toStatus(x: unknown): UpstreamStatus {
  return typeof x === 'string' && (VALID_STATUSES as string[]).includes(x)
    ? (x as UpstreamStatus)
    : 'failed';
}

/** Build the succeeded poll output + usage for the requested modality. */
function succeededFor(
  modality: string,
  jobId: string,
): { output: Record<string, unknown>; usage: UsageVector } {
  const url = `https://mock.local/${jobId}`;
  if (modality === 'video') {
    return { output: { video_url: url }, usage: { duration_seconds: MOCK_VIDEO_DURATION_SECONDS } };
  }
  return { output: { image_url: url }, usage: { images: 1 } };
}

const UNKNOWN_JOB_ERROR: UnifiedError = {
  code: 'upstream_error',
  message: 'async-media-mock: unknown upstream job id',
  upstream: { provider: PROVIDER },
  retryable: false,
};

/**
 * In-process mock of an async media provider that exercises the poll state
 * machine without any network. `submit` mints a `crypto.randomUUID()` job id and
 * records the modality; `poll` advances a counter, reporting `running` until it
 * reaches `readyAfterPolls`, then `succeeded` with an `{image_url|video_url}`
 * output and a usage vector. Unknown ids report `failed`.
 */
export function createAsyncMediaMock(opts?: AsyncMediaMockOptions): ProviderAdapter {
  const readyAfterPolls = opts?.readyAfterPolls ?? DEFAULT_READY_AFTER_POLLS;
  const jobs = new Map<string, JobState>();

  return {
    providerType: PROVIDER,

    submit(input: SubmitInput): Promise<SubmitResult> {
      const upstreamJobId = randomUUID();
      jobs.set(upstreamJobId, { modality: input.modality, polls: 0 });
      return Promise.resolve({
        kind: 'async',
        provider: PROVIDER,
        upstreamJobId,
        meta: { modality: input.modality },
      });
    },

    poll(upstreamJobId: string): Promise<PollResult> {
      const job = jobs.get(upstreamJobId);
      if (job === undefined) {
        return Promise.resolve({ status: 'failed', error: UNKNOWN_JOB_ERROR });
      }

      job.polls += 1;
      if (job.polls < readyAfterPolls) {
        return Promise.resolve({ status: 'running' });
      }

      const { output, usage } = succeededFor(job.modality, upstreamJobId);
      return Promise.resolve({
        status: 'succeeded',
        output,
        usage,
        mediaResult: toMediaResult(output, inferModality(output)),
      });
    },

    parseCallback(payload: unknown): CallbackResult {
      const rec = asRecord(payload);
      const upstreamJobId = typeof rec?.upstreamJobId === 'string' ? rec.upstreamJobId : '';
      return { upstreamJobId, status: toStatus(rec?.status) };
    },

    extractUsage(): UsageVector {
      return {};
    },

    mapError(): UnifiedError {
      return UNKNOWN_JOB_ERROR;
    },
  };
}
