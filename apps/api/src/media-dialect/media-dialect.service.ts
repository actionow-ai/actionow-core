// apps/api/src/media-dialect/media-dialect.service.ts
//
// 批次6 D2 — the OpenAI media dialects RE-HOMED onto the NEW supply gateway.
// The legacy implementation drove the seeded `image-relay` / `audio-relay`
// resources through the OLD execution world (RunService → ExecutionService →
// in-process JobRunner); that world is deleted in this slice, so these two
// endpoints now ride the SAME serve flow as every other legacy sync face
// (the chat-v2.service 范式): auth (real api key) → §2.6 key model-allowlist →
// §2.1/§10 visibility-gated model resolution → §4.1 layer-1 facade 归一 →
// gateway.execute → dispatch on ExecuteResult.kind.
//
//   POST /v1/images/generations → operation `images.generation`
//   POST /v1/audio/speech       → operation `tts`
//
// Wire compatibility notes (deviations documented in the D2 report):
//   - `model` is REQUIRED now: the new gateway is model-addressed — the old
//     "channel default model" concept died with the resource world.
//   - a slow-marked model may answer 202 + Task (§3 自动升格, the plan's own
//     判据 2.8 wording for /v1/images/generations); fast models answer the
//     classic 200 shapes.
//   - image/audio URL extraction reuses `assetsFromJobOutput` — the SAME
//     reader the old dialect used, so canonical MediaResult outputs AND flat
//     `image_url`/`audio_url` dialect outputs both render.
import type { GatewayError, ModelOperation, Operation } from '@actionow/contracts';
import { TERMINAL_TASK_STATUSES } from '@actionow/contracts';
import type { TaskRow } from '@actionow/db';
import { assetsFromJobOutput } from '@actionow/engine';
import { fetchBytesWithTimeout } from '@actionow/infra';
import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthedRequest } from '../auth/api-key.guard.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import type { FacadeAuth } from '../gateway/facade.js';
import { toGatewayRequest } from '../gateway/facade.js';
import type { GatewayLimitBindings } from '../gateway/gateway.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { applyDeprecationHeaders, requestIdOf } from '../gateway/gateway-error.js';
import { sendOpenAIError } from '../gateway/openai-render.js';
import { toTaskView } from '../gateway/task-view.js';
import type { AudioSpeechDto, ImagesGenerationDto } from './dto/media-dialect.dto.js';

const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

/** OpenAI Images response (we always return `url`s — the §7.5/§9.4 artifact URL). */
export interface ImagesResponse {
  created: number;
  data: { url: string }[];
}

/** OpenAI `response_format` → an audio content-type (fallback when the asset omits one). */
const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};

/** What the shared serve flow hands back to the two dialect renderers. */
type Served =
  /** kind='sync' output, or a terminal-succeeded §5 replay's recorded output. */
  | { kind: 'output'; output: unknown }
  /** 202 + Task (§3 自动升格 / task paradigm); the JSON body to send. */
  | { kind: 'task'; body: Record<string, unknown> };

@Injectable()
export class MediaDialectService {
  constructor(private readonly gateway: GatewayService) {}

  /** `POST /v1/images/generations` on the new gateway (operation `images.generation`). */
  async images(
    dto: ImagesGenerationDto,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    // Canonical params only: `prompt` (+ `size` when sent). `n`, `response_format`
    // and `user` are accepted at the wire (OpenAI compat) but NOT forwarded —
    // exact parity with the legacy dialect, which never forwarded them either.
    const body: Record<string, unknown> = { prompt: dto.prompt };
    if (dto.size !== undefined) body.size = dto.size;
    if (dto.model !== undefined) body.model = dto.model;

    const served = await this.serve('images.generation', dto.model, body, req, res);
    if (served === undefined) return undefined;
    if (served.kind === 'task') return served.body;

    const urls = assetsFromJobOutput(served.output)
      .filter((a) => a.modality === 'image')
      .map((a) => a.url)
      .filter((u): u is string => u !== undefined);
    if (urls.length === 0) {
      sendOpenAIError(res, upstreamNoAsset('image'), requestIdOf(req));
      return undefined;
    }
    return { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) };
  }

  /**
   * `POST /v1/audio/speech` on the new gateway (operation `tts`). Like OpenAI,
   * a sync result answers the RAW AUDIO BYTES (binary body); a slow-marked
   * model answers 202 + Task JSON instead (§3 自动升格 — poll `/v1/tasks/:id`
   * for the artifact URL). This handler owns the response end-to-end.
   */
  async speech(dto: AudioSpeechDto, req: Request, res: Response): Promise<void> {
    // The canonical TTS vocabulary keeps the legacy relay's param names
    // (`prompt`/`voice`/`format`/`speed`) so contracts authored for the old
    // audio-relay io_schema port over 1:1.
    const body: Record<string, unknown> = { prompt: dto.input };
    if (dto.voice !== undefined) body.voice = dto.voice;
    if (dto.response_format !== undefined) body.format = dto.response_format;
    if (dto.speed !== undefined) body.speed = dto.speed;
    if (dto.model !== undefined) body.model = dto.model;

    const served = await this.serve('tts', dto.model, body, req, res);
    if (served === undefined) return;
    if (served.kind === 'task') {
      res.json(served.body);
      return;
    }

    const audioUrl = assetsFromJobOutput(served.output).find((a) => a.modality === 'audio')?.url;
    if (audioUrl === undefined) {
      sendOpenAIError(res, upstreamNoAsset('audio'), requestIdOf(req));
      return;
    }
    // The artifact URL is the persisted (R2) URL in production, or a data: URL
    // in tests — global fetch handles both.
    const fetched = await fetchBytesWithTimeout(audioUrl);
    const fallback = CONTENT_TYPE_BY_FORMAT[dto.response_format ?? 'mp3'] ?? 'audio/mpeg';
    const bytes = Buffer.from(fetched.bytes);
    res.status(200);
    res.setHeader('content-type', fetched.contentType ?? fallback);
    res.setHeader('content-length', String(bytes.byteLength));
    res.end(bytes);
  }

  // --- the shared serve flow (the chat-v2 范式, media-shaped) ---------------------------

  private async serve(
    operation: Operation,
    modelName: string | undefined,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Served | undefined> {
    const requestId = requestIdOf(req);

    const auth = this.authOf(req, res, requestId);
    if (auth === undefined) return undefined;

    if (modelName === undefined || modelName.length === 0) {
      sendOpenAIError(
        res,
        invalidInput(
          "request requires a 'model' (the media dialects are model-addressed on the supply gateway)",
        ),
        requestId,
      );
      return undefined;
    }

    // §2.6 key model-allowlist ([] = allow all).
    const allowlist = await this.gateway.modelAllowlist(auth.apiKeyId);
    if (allowlist.length > 0 && !allowlist.includes(modelName)) {
      sendOpenAIError(res, modelNotFound(modelName), requestId);
      return undefined;
    }

    // §2.1/§10 visibility gate — this read hands the facade its canonical contract.
    const model = await this.gateway.resolveVisibleModel(modelName, auth.tenantId);
    if (model === undefined) {
      sendOpenAIError(res, modelNotFound(modelName), requestId);
      return undefined;
    }

    const contract: ModelOperation | undefined = model.operations.find(
      (op) => op.operation === operation,
    );
    if (contract === undefined) {
      sendOpenAIError(
        res,
        invalidInput(`model '${model.name}' does not expose operation '${operation}'`),
        requestId,
      );
      return undefined;
    }

    // §4.1 layer 1 — canonical 归一 (isDefault marking; NO offering semantics).
    const parsed = toGatewayRequest({
      operation,
      modelName: model.name,
      contract,
      body,
      auth: {
        tenantId: auth.tenantId,
        apiKeyId: auth.apiKeyId,
        ...(auth.subjectId !== undefined ? { subjectId: auth.subjectId } : {}),
      },
      idempotencyKey: idempotencyKeyHeader(req),
      routeTag: routeTagHeader(req),
    });
    if (!parsed.ok) {
      sendOpenAIError(res, parsed.error, requestId);
      return undefined;
    }

    const result = await this.gateway.execute(parsed.request, {
      accountId: auth.accountId,
      keyRpm: auth.keyRpm,
      ...(auth.routeGroupId !== null ? { routeGroupId: auth.routeGroupId } : {}),
      limits: auth.limits,
    });

    applyDeprecationHeaders(res, result.deprecation);
    switch (result.kind) {
      case 'sync':
        this.stampServedBy(res, result.response.servedBy);
        return { kind: 'output', output: result.response.output };
      case 'stream':
        // Unreachable: the media facades never set `options.stream`. Drain-free
        // defensive answer so a future contract slip is an honest 500.
        sendOpenAIError(
          res,
          {
            code: 'internal_error',
            message: `operation '${operation}' unexpectedly answered a stream`,
            retryable: false,
            failover: false,
          },
          requestId,
        );
        return undefined;
      case 'task': {
        // §3 自动升格 (slow-marked contract): 202 + Task. fetch=direct runs
        // fire-and-forget in this process (it settles/fails the row itself).
        if (result.run !== undefined) {
          void result.run().catch(() => {
            // runDirectTask already routed the failure into the task row.
          });
        }
        res.status(202);
        return { kind: 'task', body: toTaskView(result.task) };
      }
      case 'replay':
        return this.replayOf(result.task, res, requestId);
      case 'error':
        sendOpenAIError(res, result.error, requestId);
        return undefined;
    }
  }

  /** §5 同键同体回放 on a sync media surface (no 202 vocabulary for "in flight"). */
  private replayOf(task: TaskRow, res: Response, requestId: string): Served | undefined {
    if (task.status === 'succeeded') {
      res.status(200);
      return { kind: 'output', output: task.output };
    }
    if (TERMINAL.includes(task.status)) {
      sendOpenAIError(
        res,
        task.error ?? {
          code: 'task_failed',
          message: `the original request for this Idempotency-Key ended '${task.status}'`,
          retryable: false,
          failover: false,
        },
        requestId,
      );
      return undefined;
    }
    sendOpenAIError(
      res,
      {
        code: 'conflict',
        message: 'a request with this Idempotency-Key is still in progress',
        retryable: true,
        failover: false,
      },
      requestId,
    );
    return undefined;
  }

  /** The guard-attached auth context — a REAL api key is required (frozen IR). */
  private authOf(
    req: Request,
    res: Response,
    requestId: string,
  ):
    | (FacadeAuth & {
        accountId: string;
        keyRpm: number | null;
        routeGroupId: string | null;
        limits: GatewayLimitBindings;
      })
    | undefined {
    const auth = (req as AuthedRequest).auth;
    if (auth?.apiKeyId == null) {
      sendOpenAIError(
        res,
        {
          code: 'unauthorized',
          message: 'the gateway requires an API key',
          retryable: false,
          failover: false,
        },
        requestId,
      );
      return undefined;
    }
    return {
      tenantId: auth.tenantId,
      apiKeyId: auth.apiKeyId,
      ...(auth.subjectId !== null ? { subjectId: auth.subjectId } : {}),
      accountId: auth.accountId,
      keyRpm: auth.rateLimit,
      routeGroupId: auth.routeGroupId,
      limits: {
        keyLimitPlanId: auth.limitPlanId,
        tenantLimitPlanId: auth.tenantLimitPlanId,
        subjectLimitPlanId: auth.subjectLimitPlanId,
      },
    };
  }

  /** §8 可观测: echo WHICH offering served (parity with the chat-v2 headers). */
  private stampServedBy(
    res: Response,
    servedBy: { offeringId: string; channelId: string; provider?: string | undefined },
  ): void {
    res.setHeader('x-actionow-offering', servedBy.offeringId);
    if (servedBy.provider !== undefined) res.setHeader('x-actionow-channel', servedBy.provider);
  }
}

// --- error builders --------------------------------------------------------------------

function invalidInput(message: string): GatewayError {
  return { code: 'invalid_input', message, retryable: false, failover: false };
}

function modelNotFound(model: string): GatewayError {
  return {
    code: 'model_not_found',
    message: `model '${model}' does not exist or is not available`,
    retryable: false,
    failover: false,
  };
}

function upstreamNoAsset(modality: 'image' | 'audio'): GatewayError {
  return {
    code: 'upstream_error',
    message: `the ${modality} generation returned no ${modality} asset`,
    retryable: false,
    failover: false,
  };
}
