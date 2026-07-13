import {
  type TranscriptionInput,
  type TranscriptionRequest,
  transcriptionRequestSchema,
  type TranscriptionResponse,
  type TranscriptionResult,
} from '@actionow/contracts';
import type { AppEnv } from '@actionow/infra';
import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { engineInvalidInput } from '../common/errors.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ENV } from '../common/tokens.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';
import { SttRelayService } from './stt-relay.service.js';

/**
 * Hard ceiling on the multipart upload the `FileInterceptor` accepts, applied at
 * decoration time (multer cannot read DI). Matches OpenAI's Whisper 25 MiB cap; a
 * lower operator override (`STT_MAX_UPLOAD_BYTES`) is enforced additionally in the
 * handler (so the configured limit is always honored, never only this hard cap).
 */
const HARD_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The minimal `Express.Multer.File` surface this handler reads. */
interface UploadedAudio {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * OpenAI-compatible speech-to-text relay: `POST /v1/audio/transcriptions`
 * (multipart/form-data). A downstream caller can point the OpenAI SDK's
 * `base_url` here and call `client.audio.transcriptions.create({ file, model })`
 * unchanged. The audio binary rides as the multipart `file` part; the remaining
 * fields (`model`, `language`, `prompt`, `response_format`, `temperature`) are
 * zod-validated. Resolves the seeded `stt-relay` resource → routes to a channel →
 * calls the upstream `/v1/audio/transcriptions`, billed per AUDIO SECOND against
 * the wallet (a REAL hold → settle) through the SAME engine machinery as the
 * embeddings relay. The client-requested `response_format` shapes the response.
 *
 * 切换预案③ (批次5 slice6, 双面并存): the ONE branch below routes a
 * gray-released tenant (预案② `isV2Tenant`) through the NEW supply gateway
 * ({@link GatewayChatV2Service} — the audio part rides the §9.4 media input
 * path, the multipart text fields ride raw) end to end; every other tenant
 * rides the untouched legacy relay path. The auth resolve is hoisted to the
 * entry (a pure guard-context projection) so the branch can run first.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/audio')
export class TranscriptionsController {
  constructor(
    private readonly relay: SttRelayService,
    private readonly auth: AuthService,
    private readonly gatewayV2: GatewayChatV2Service,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  @Post('transcriptions')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'OpenAI-compatible speech-to-text (billed per audio second)' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_MAX_UPLOAD_BYTES } }))
  async create(
    @UploadedFile() file: UploadedAudio | undefined,
    // The non-file multipart fields parsed by multer land on `req.body` as
    // strings; validate them with zod (the controller owns the file separately).
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TranscriptionResponse | Record<string, unknown> | string | undefined> {
    const ctx = this.auth.resolve(req);
    if (await this.gatewayV2.isV2Tenant(ctx.tenantId)) {
      return this.gatewayV2.transcriptions(
        file,
        (req.body ?? {}) as Record<string, unknown>,
        req,
        res,
      );
    }
    if (file === undefined) {
      throw engineInvalidInput('a multipart "file" part is required');
    }
    // Enforce the configured (possibly operator-lowered) max upload as a clean
    // invalid_input, BELOW the interceptor's hard ceiling.
    const maxBytes = this.env.STT_MAX_UPLOAD_BYTES ?? HARD_MAX_UPLOAD_BYTES;
    if (file.size > maxBytes) {
      throw engineInvalidInput(
        `audio upload exceeds the ${String(maxBytes)}-byte limit (${String(file.size)} bytes)`,
      );
    }

    // multipart text fields are strings on req.body; coerce + zod-validate them.
    const dto = parseTranscriptionFields(req.body);

    const idem = idempotencyKeyHeader(req);
    const routeTag = routeTagHeader(req);

    // Copy the multer Buffer into a fresh ArrayBuffer-backed Uint8Array (a Node
    // Buffer is ArrayBufferLike-backed, which the contract's `file` field rejects).
    const fileBytes = new Uint8Array(file.buffer.byteLength);
    fileBytes.set(file.buffer);
    const ir: TranscriptionInput = {
      model: dto.model,
      file: fileBytes,
      filename: file.originalname,
      ...(file.mimetype !== '' ? { contentType: file.mimetype } : {}),
      ...(dto.language !== undefined ? { language: dto.language } : {}),
      ...(dto.prompt !== undefined ? { prompt: dto.prompt } : {}),
      ...(dto.temperature !== undefined ? { temperature: dto.temperature } : {}),
    };

    const { result, servedBy } = await this.relay.transcribe(ir, ctx, idem, routeTag);
    if (servedBy !== undefined) res.setHeader('x-actionow-channel', servedBy.providerType);

    return renderTranscription(result, dto.responseFormat);
  }
}

/**
 * Validate the non-file multipart fields against the contract schema. multer
 * delivers every text part as a STRING, so `temperature` is coerced to a number
 * (when present) before zod runs; a bad value surfaces as `invalid_input` (400).
 */
function parseTranscriptionFields(rawBody: unknown): TranscriptionRequest {
  const body = (typeof rawBody === 'object' && rawBody !== null ? rawBody : {}) as Record<
    string,
    unknown
  >;
  const coerced: Record<string, unknown> = { ...body };
  if (typeof body.temperature === 'string' && body.temperature !== '') {
    const n = Number(body.temperature);
    coerced.temperature = Number.isNaN(n) ? body.temperature : n;
  }
  // OpenAI's wire field is snake_case `response_format`; accept it and map to the
  // camelCase contract field (the SDK sends snake_case).
  if (coerced.responseFormat === undefined && typeof body.response_format === 'string') {
    coerced.responseFormat = body.response_format;
  }
  // Validate inline (not via the ZodBody pipe, whose generic assumes input ===
  // output — broken by the schema's `responseFormat` `.default('json')`). On
  // failure throw the same `invalid_input` (400) the pipe would.
  const result = transcriptionRequestSchema.safeParse(coerced);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    throw engineInvalidInput(first === undefined ? 'invalid body' : `${path}: ${first.message}`);
  }
  return result.data;
}

/**
 * Shape the dialect-neutral {@link TranscriptionResult} into the client-requested
 * `response_format`:
 * - `text` → the raw transcript string (the controller sends it as plain text).
 * - `json` → `{ text }`.
 * - `verbose_json` → `{ text, language?, duration?, segments? }`.
 */
function renderTranscription(
  result: TranscriptionResult,
  format: TranscriptionRequest['responseFormat'],
): TranscriptionResponse | string {
  if (format === 'text') return result.text;
  if (format === 'verbose_json') {
    const out: TranscriptionResponse = { text: result.text };
    if (result.language !== undefined) out.language = result.language;
    if (result.duration !== undefined) out.duration = result.duration;
    if (result.segments !== undefined) out.segments = result.segments;
    return out;
  }
  // default `json`: just the transcript text.
  return { text: result.text };
}
