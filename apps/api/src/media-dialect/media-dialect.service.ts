import type { AdapterRegistry } from '@actionow/adapters';
import type { StorageProvider } from '@actionow/contracts';
import {
  createFileObject,
  type Database,
  getJob,
  insertUsageLog,
  type Job,
  markFileReady,
} from '@actionow/db';
import type {
  InsertMediaUsageLogFn,
  JobExecutionContext,
  PersistMediaResultFn,
  RunRequest,
} from '@actionow/engine';
import {
  assetsFromJobOutput,
  EngineError,
  ExecutionService,
  JobRunner,
  persistMediaResult,
} from '@actionow/engine';
import {
  type AppEnv,
  fetchBytesWithTimeout,
  FetchHttpClient,
  putBytesWithTimeout,
} from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, STORAGE } from '../common/tokens.js';
import { RunService } from '../execution/run.service.js';
import type { AudioSpeechDto, ImagesGenerationDto } from './dto/media-dialect.dto.js';

/** The seeded media resource ids the dialects relay onto. */
const IMAGE_RESOURCE = 'image-relay';
const AUDIO_RESOURCE = 'audio-relay';

/** OpenAI Images response (we always return relayed/persisted `url`s). */
export interface ImagesResponse {
  created: number;
  data: { url: string }[];
}
/** The audio dialect's binary result: the raw bytes + their content type. */
export interface SpeechResult {
  bytes: Uint8Array;
  contentType: string;
}

/** OpenAI `response_format` → an audio content-type (fallback when the relay omits one). */
const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};

/**
 * Maps the OpenAI media dialects (`/v1/images/generations`, `/v1/audio/speech`)
 * onto a SYNCHRONOUS run of the seeded `image-relay` / `audio-relay` resource.
 * The relay is async (submit→poll), but these OpenAI endpoints return the result
 * inline — so this drives the job to a terminal state IN-PROCESS: it creates the
 * queued job with a no-op `enqueue` (no BullMQ), then runs the EXACT
 * submit→poll→persist→settle the worker's {@link JobRunner} does, just inline.
 * Zero engine changes; the hold/settle path is reused unchanged.
 */
@Injectable()
export class MediaDialectService {
  private readonly http = new FetchHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(STORAGE) private readonly storage: StorageProvider | null,
    private readonly secrets: SecretResolver,
    private readonly runService: RunService,
  ) {}

  /** `POST /v1/images/generations` → relay `image-relay`, return the image url(s). */
  async images(dto: ImagesGenerationDto, ctx: TenantContext): Promise<ImagesResponse> {
    const n = dto.n ?? 1;
    const inputs: Record<string, unknown> = { prompt: dto.prompt };
    if (dto.size !== undefined) inputs.size = dto.size;
    // Per-image hold (the relay meters `{ images: N }` at settle).
    const job = await this.runToTerminal(IMAGE_RESOURCE, inputs, { images: n }, ctx);
    const urls = assetsFromJobOutput(job.output)
      .filter((a) => a.modality === 'image')
      .map((a) => a.url)
      .filter((u): u is string => u !== undefined);
    if (urls.length === 0) {
      throw new EngineError({
        code: 'upstream_error',
        message: 'image relay returned no image',
        retryable: false,
      });
    }
    return { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) };
  }

  /** `POST /v1/audio/speech` → relay `audio-relay`, return the raw audio BYTES. */
  async speech(dto: AudioSpeechDto, ctx: TenantContext): Promise<SpeechResult> {
    const inputs: Record<string, unknown> = { prompt: dto.input };
    if (dto.voice !== undefined) inputs.voice = dto.voice;
    if (dto.response_format !== undefined) inputs.format = dto.response_format;
    if (dto.speed !== undefined) inputs.speed = dto.speed;
    // Size the hold for BOTH dims the relay might meter — per-character (TTS, the
    // OpenAI standard) AND per-second (generative audio) — so a duration-metering
    // relay does NOT under-hold (settle charges the actual single dim, capped by
    // neither side: a too-small hold would let the settle over-spend the balance).
    // `ceil(len/2)` is a conservative (≈2 chars/sec) upper bound on the duration.
    const len = dto.input.length;
    const job = await this.runToTerminal(
      AUDIO_RESOURCE,
      inputs,
      { characters: len, audio_seconds: Math.ceil(len / 2) },
      ctx,
    );
    const audioUrl = assetsFromJobOutput(job.output).find((a) => a.modality === 'audio')?.url;
    if (audioUrl === undefined) {
      throw new EngineError({
        code: 'upstream_error',
        message: 'audio relay returned no audio',
        retryable: false,
      });
    }
    // The url is the persisted (public R2) url in production, or a data: url in
    // tests — global fetch handles both, so no storage/network mock is needed.
    const fetched = await fetchBytesWithTimeout(audioUrl);
    const fallback = CONTENT_TYPE_BY_FORMAT[dto.response_format ?? 'mp3'] ?? 'audio/mpeg';
    return { bytes: fetched.bytes, contentType: fetched.contentType ?? fallback };
  }

  /**
   * Build a RunRequest, create the queued job WITHOUT enqueuing, then drive it to
   * terminal IN-PROCESS via a JobRunner. Synchronous: blocks until the job
   * settles (bounded by the channel poll budget). A non-succeeded job surfaces
   * its unified error (mapped to the §4.7 HTTP envelope by the global filter).
   */
  private async runToTerminal(
    resourceId: string,
    inputs: Record<string, unknown>,
    estimatedUsage: Record<string, number>,
    ctx: TenantContext,
  ): Promise<Job> {
    // `estimated_usage` sizes the credit hold for the post-timed media pricebook
    // (which otherwise rejects the run); the settle re-prices from the real usage.
    const req = await this.runService.resolveRunRequest(
      resourceId,
      { inputs, exec_mode: 'async-poll', estimated_usage: estimatedUsage },
      ctx,
    );
    const outcome = await this.buildExec().run(req);
    await this.buildRunner(req).process(outcome.jobId);
    const job = await getJob(this.db, outcome.jobId);
    if (job === undefined) {
      throw new EngineError({
        code: 'internal_error',
        message: 'media job vanished',
        retryable: false,
      });
    }
    if (job.status !== 'succeeded') {
      throw new EngineError(
        job.error ?? { code: 'upstream_error', message: 'media job failed', retryable: false },
      );
    }
    return job;
  }

  /** An ExecutionService that holds + snapshots the job but does NOT enqueue (no worker). */
  private buildExec(): ExecutionService {
    return new ExecutionService({
      db: this.db,
      adapters: this.adapters,
      resolveSecret: (ref: string): Promise<string | undefined> => this.secrets.resolve(ref),
      http: this.http,
      now: () => new Date(),
      enqueue: (): Promise<void> => Promise.resolve(),
      proxyUrlEnv: this.env.UPSTREAM_PROXY_URL,
      traceUpstream: this.env.RELAY_TRACE === 'full',
      traceMaxBytes: this.env.RELAY_TRACE_MAX_BYTES,
    });
  }

  /** A JobRunner whose context is derived from the in-hand RunRequest (no db re-read). */
  private buildRunner(req: RunRequest): JobRunner {
    const persistMediaResultFn = this.buildPersistMediaResult();
    const insertUsageLogFn: InsertMediaUsageLogFn = async (row) => {
      await insertUsageLog(this.db, row);
    };
    const context: JobExecutionContext = {
      accountId: req.accountId,
      providerType: req.resource.providerType,
      modality: req.resource.modality,
      pricebookEntry: req.pricebookEntry,
      modifiers: req.modifiers,
      channels: req.channels,
    };
    return new JobRunner({
      db: this.db,
      adapters: this.adapters,
      loadContext: (): Promise<JobExecutionContext> => Promise.resolve(context),
      resolveSecret: (ref: string): Promise<string | undefined> => this.secrets.resolve(ref),
      http: this.http,
      proxyUrlEnv: this.env.UPSTREAM_PROXY_URL,
      traceUpstream: this.env.RELAY_TRACE === 'full',
      traceMaxBytes: this.env.RELAY_TRACE_MAX_BYTES,
      insertUsageLog: insertUsageLogFn,
      ...(persistMediaResultFn !== undefined ? { persistMediaResult: persistMediaResultFn } : {}),
    });
  }

  /**
   * The P1 canonical-result persistence closure (mirrors the worker): copy a
   * MediaResult's assets to R2 + record a `file_object` per object (with media
   * dims). Undefined when storage is unconfigured.
   */
  private buildPersistMediaResult(): PersistMediaResultFn | undefined {
    const storage = this.storage;
    const publicBaseUrl = this.env.STORAGE_PUBLIC_BASE_URL;
    if (storage === null || publicBaseUrl === undefined) return undefined;
    const db = this.db;
    const bucket = this.env.STORAGE_BUCKET ?? '';
    return async ({ tenantId, jobId, result }) => {
      const persisted = await persistMediaResult({
        storage,
        publicBaseUrl,
        tenantId,
        jobId,
        result,
        fetchBytes: fetchBytesWithTimeout,
        putBytes: putBytesWithTimeout,
      });
      for (const obj of persisted.objects) {
        try {
          const file = await createFileObject(db, {
            tenantId,
            provider: storage.kind,
            bucket,
            key: obj.key,
          });
          await markFileReady(db, file.id, {
            ...(obj.size !== undefined ? { size: obj.size } : {}),
            ...(obj.contentType !== undefined ? { contentType: obj.contentType } : {}),
            ...(obj.width !== undefined ? { width: obj.width } : {}),
            ...(obj.height !== undefined ? { height: obj.height } : {}),
            ...(obj.duration !== undefined ? { duration: obj.duration } : {}),
          });
        } catch {
          // best-effort; the asset url is already rewritten.
        }
      }
      return persisted;
    };
  }
}
