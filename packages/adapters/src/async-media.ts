import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  AdapterContext,
  CallbackResult,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asNumber, asRecord, asString } from './internal/json.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'async-media';
/** Default replay window for webhook timestamps (ms). */
const TIMESTAMP_WINDOW_MS = 5 * 60_000;

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

/** The verified-callback envelope the engine hands to {@link parseCallback}. */
export interface AsyncMediaCallbackEnvelope {
  /** The exact raw request bytes the HMAC was computed over. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /** The channel signing secret (resolved by the engine; never logged). */
  secret: string;
  /** Injected clock (unix ms) for the replay-window check. */
  nowMs: number;
  /** Header name carrying the HMAC signature (from per-channel config). */
  signatureHeader: string;
  /** Header name carrying the unix-seconds timestamp (from per-channel config). */
  timestampHeader: string;
  /** Replay window override (ms); defaults to 5 minutes. */
  replayWindowMs?: number;
}

/** Build `params` for the task from the unified inputs, per modality. */
function buildParams(modality: string, inputs: Record<string, unknown>): Record<string, unknown> {
  const prompt = asString(inputs.prompt) ?? asString(inputs.input);
  if (prompt === undefined) {
    throw new AdapterError({
      code: 'invalid_input',
      message: 'async-media inputs require a "prompt" string',
      upstream: { provider: PROVIDER },
      retryable: false,
    });
  }
  const params: Record<string, unknown> = { prompt };
  if (modality === 'video') {
    const duration = asNumber(inputs.duration);
    if (duration !== undefined) params.duration = duration;
    const ratio = asString(inputs.ratio);
    if (ratio !== undefined) params.ratio = ratio;
  } else {
    const size = asString(inputs.size);
    if (size !== undefined) params.size = size;
  }
  return params;
}

/** Map a completed `result` block to the unified output (media URLs preserved). */
function resultOutput(result: Record<string, unknown> | undefined): Record<string, unknown> {
  if (result === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    'image_url',
    'image_urls',
    'image_count',
    'size',
    'video_url',
    'duration',
    'resolution',
    'ratio',
  ]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

/** Read a header value (lower-cased lookup); collapses arrays to the first entry. */
function header(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = headers[key.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

export const asyncMediaAdapter: ProviderAdapter = {
  providerType: PROVIDER,

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { ctx, inputs, modality } = input;
    const submitPath = asString(ctx.config?.submitPath);
    if (ctx.endpoint === undefined || submitPath === undefined || ctx.model === undefined) {
      throw new AdapterError({
        code: 'invalid_input',
        message: 'async-media submit requires endpoint, config.submitPath and model',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    const params = buildParams(modality, inputs);

    const body: Record<string, unknown> = { model: ctx.model, params };
    const webhookUrl = asString(inputs.webhook_url);
    if (webhookUrl !== undefined) body.webhook_url = webhookUrl;
    const idemKey = asString(inputs.idempotency_key);
    if (idemKey !== undefined) body.idempotency_key = idemKey;

    const res = await ctx.http.request({
      method: 'POST',
      url: `${ctx.endpoint}${submitPath}`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
      ...withProxy(ctx),
    });
    if (!res.ok) {
      throw new AdapterError(httpStatusToUnified(PROVIDER, res.status));
    }
    const taskId = asString(asRecord(res.body)?.task_id);
    if (taskId === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'async-media submit did not return a task_id',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    return { kind: 'async', provider: PROVIDER, upstreamJobId: taskId, meta: { modality } };
  },

  async poll(upstreamJobId, ctx): Promise<PollResult> {
    const pollPath = asString(ctx.config?.pollPath);
    if (ctx.endpoint === undefined || pollPath === undefined) {
      throw new AdapterError({
        code: 'invalid_input',
        message: 'async-media poll requires endpoint and config.pollPath',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    const res = await ctx.http.request({
      method: 'GET',
      url: `${ctx.endpoint}${pollPath.replace('{id}', upstreamJobId)}`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      ...withProxy(ctx),
    });
    if (!res.ok) {
      return { status: 'failed', error: httpStatusToUnified(PROVIDER, res.status) };
    }
    const data = asRecord(res.body);
    const status = asString(data?.status);
    if (status === 'completed') {
      return {
        status: 'succeeded',
        output: resultOutput(asRecord(data?.result)),
        usage: { tasks: 1 },
      };
    }
    if (status === 'failed') {
      return {
        status: 'failed',
        error: {
          code: 'job_failed',
          message: asString(data?.error_message) ?? 'async-media task failed',
          upstream: { provider: PROVIDER },
          retryable: false,
        },
      };
    }
    // pending | processing | unknown → still running.
    return { status: 'running' };
  },

  parseCallback(payload: unknown): CallbackResult {
    const env = payload as Partial<AsyncMediaCallbackEnvelope>;
    const empty: CallbackResult = { upstreamJobId: '', status: 'failed' };
    if (
      typeof env.rawBody !== 'string' ||
      env.headers === undefined ||
      typeof env.secret !== 'string' ||
      typeof env.signatureHeader !== 'string' ||
      typeof env.timestampHeader !== 'string'
    ) {
      return empty;
    }
    const windowMs = env.replayWindowMs ?? TIMESTAMP_WINDOW_MS;
    const ts = header(env.headers, env.timestampHeader);
    const sig = header(env.headers, env.signatureHeader);
    if (ts === undefined || sig === undefined) return empty;
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs((env.nowMs ?? 0) - tsMs) > windowMs) {
      return empty;
    }
    const expected = createHmac('sha256', env.secret).update(`${ts}.${env.rawBody}`).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return empty;

    const parsed = asRecord(JSON.parse(env.rawBody));
    const taskId = asString(parsed?.task_id);
    const data = asRecord(parsed?.data);
    if (taskId === undefined || data === undefined) return empty;
    const status = asString(data.status);
    if (status === 'completed') {
      return {
        upstreamJobId: taskId,
        status: 'succeeded',
        output: resultOutput(asRecord(data.result)),
        usage: { tasks: 1 },
      };
    }
    return {
      upstreamJobId: taskId,
      status: 'failed',
      error: {
        code: 'job_failed',
        message: asString(data.error_message) ?? 'async-media task failed',
        upstream: { provider: PROVIDER },
        retryable: false,
      },
    };
  },

  extractUsage(raw: unknown): UsageVector {
    const status = asString(asRecord(raw)?.status);
    return status === 'completed' ? { tasks: 1 } : {};
  },

  mapError(raw: unknown): UnifiedError {
    return {
      code: 'job_failed',
      message: asString(asRecord(raw)?.error_message) ?? 'async-media task failed',
      upstream: { provider: PROVIDER },
      retryable: false,
    };
  },
};
