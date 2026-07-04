import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  AdapterContext,
  Asset,
  CallbackResult,
  MediaResult,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { mediaResultSchema } from '@actionow/contracts';

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
  } else if (modality === 'audio') {
    // TTS / generative-audio params: voice + language + output format pass through
    // verbatim; `speed` is numeric (playback rate).
    for (const key of ['voice', 'voice_id', 'language', 'format'] as const) {
      const v = asString(inputs[key]);
      if (v !== undefined) params[key] = v;
    }
    const speed = asNumber(inputs.speed);
    if (speed !== undefined) params.speed = speed;
  } else {
    const size = asString(inputs.size);
    if (size !== undefined) params.size = size;
  }
  // img2img / reference-image (参考生图): the reference image can arrive as a
  // direct public URL (`image_url`) OR an uploaded file — the run path resolves a
  // `file` input (a file_id) to a presigned GET URL under `image` before the
  // adapter sees it. Normalize whichever key is present to the relay's `image_url`
  // task param (HuiMeng's reference param; verified against its API).
  const refImage =
    asString(inputs.image_url) ??
    asString(inputs.image) ??
    asString(inputs.init_image) ??
    asString(inputs.reference_image);
  if (refImage !== undefined) params.image_url = refImage;
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
    'audio_url',
    'audio_duration',
    'character_count',
    'sample_rate',
    'format',
  ]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

/**
 * Derive the metered {@link UsageVector} from a completed task's `result`, so a
 * media job bills per OUTPUT UNIT (per image, per second of video, per character or
 * second of audio) rather than a flat per-task charge. Image count comes from
 * `image_count`/`generated_images`/the `image_urls` length; AUDIO from
 * `character_count`/`characters` (TTS, per input character) else
 * `audio_duration`/`audio_seconds` (generative audio, per second); video seconds
 * from `duration`. Falls back to `{ tasks: 1 }` when no dimension is present, so a
 * `tasks`-priced pricebook still settles.
 */
function usageFromResult(result: Record<string, unknown> | undefined): UsageVector {
  if (result === undefined) return { tasks: 1 };
  const imageUrls = result.image_urls;
  const images =
    asNumber(result.image_count) ??
    asNumber(result.generated_images) ??
    (Array.isArray(imageUrls) ? imageUrls.length : undefined) ??
    (result.image_url !== undefined ? 1 : undefined);
  if (images !== undefined) return { images };
  const characters = asNumber(result.character_count) ?? asNumber(result.characters);
  if (characters !== undefined) return { characters };
  const audioSeconds = asNumber(result.audio_duration) ?? asNumber(result.audio_seconds);
  if (audioSeconds !== undefined) return { audio_seconds: audioSeconds };
  const duration = asNumber(result.duration) ?? asNumber(result.duration_seconds);
  if (duration !== undefined) return { duration_seconds: duration };
  return { tasks: 1 };
}

/** Default mime per modality when a URL extension yields no hint. */
const DEFAULT_MIME: Record<string, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
};
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

/** Best-effort mime from a URL's extension, falling back to the modality default. */
function mimeOf(url: string, modality: string): string {
  const noQuery = url.split('?')[0] ?? url;
  const ext = noQuery.split('.').pop()?.toLowerCase();
  return (
    (ext !== undefined ? MIME_BY_EXT[ext] : undefined) ??
    DEFAULT_MIME[modality] ??
    'application/octet-stream'
  );
}

/** Infer the modality of a completed `result` from which url key it carries. */
export function inferModality(result: Record<string, unknown> | undefined): string {
  if (result === undefined) return 'image';
  if (asString(result.video_url) !== undefined) return 'video';
  if (asString(result.audio_url) !== undefined) return 'audio';
  return 'image';
}

/**
 * Normalize an async-media `result` block to the canonical {@link MediaResult} —
 * the SINGLE source of media field knowledge (supersedes the per-call key
 * allow-lists). Asset URLs come from `image_urls[]` (batch) then the single
 * `image_url`/`video_url`/`audio_url`; `usage` mirrors {@link usageFromResult}'s
 * dimension precedence (images → characters → audio_seconds → duration_seconds →
 * tasks).
 */
export function toMediaResult(
  result: Record<string, unknown> | undefined,
  modality: string,
): MediaResult {
  const assetModality: Asset['modality'] =
    modality === 'video' ? 'video' : modality === 'audio' ? 'audio' : 'image';
  const urls: string[] = [];
  const arr = result?.image_urls;
  if (Array.isArray(arr))
    for (const u of arr) if (typeof u === 'string' && !urls.includes(u)) urls.push(u);
  for (const k of ['image_url', 'video_url', 'audio_url'] as const) {
    const u = asString(result?.[k]);
    if (u !== undefined && !urls.includes(u)) urls.push(u);
  }
  const duration = asNumber(result?.duration) ?? asNumber(result?.audio_duration);
  const assets: Asset[] = urls.map((u) => ({
    role: 'primary' as const,
    modality: assetModality,
    url: u,
    mime: mimeOf(u, modality),
    ...(assetModality !== 'image' && duration !== undefined ? { duration } : {}),
  }));
  return mediaResultSchema.parse({
    kind: 'media',
    assets,
    usage: usageFromResult(result),
    raw: result,
  });
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
    // Upstream model: a per-request `inputs.model` (media model passthrough — lets
    // ONE relay channel serve every model the provider offers, e.g. all of
    // HuiMeng's seedream/seedance/kling ids) takes precedence over the channel's
    // configured default `ctx.model`. `buildParams` never copies `model`, so it
    // is carried ONLY as the task's top-level `model`.
    const upstreamModel = asString(inputs.model) ?? ctx.model;
    if (ctx.endpoint === undefined || submitPath === undefined || upstreamModel === undefined) {
      throw new AdapterError({
        code: 'invalid_input',
        message: 'async-media submit requires endpoint, config.submitPath and a model',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    const params = buildParams(modality, inputs);

    const body: Record<string, unknown> = { model: upstreamModel, params };
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
      const result = asRecord(data?.result);
      return {
        status: 'succeeded',
        output: resultOutput(result),
        usage: usageFromResult(result),
        mediaResult: toMediaResult(result, inferModality(result)),
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
      const result = asRecord(data.result);
      return {
        upstreamJobId: taskId,
        status: 'succeeded',
        output: resultOutput(result),
        usage: usageFromResult(result),
        mediaResult: toMediaResult(result, inferModality(result)),
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
    const data = asRecord(raw);
    const status = asString(data?.status);
    return status === 'completed' ? usageFromResult(asRecord(data?.result)) : {};
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
