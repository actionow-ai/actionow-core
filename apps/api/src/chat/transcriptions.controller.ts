import {
  Controller,
  HttpCode,
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
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';

/**
 * Hard ceiling on the multipart upload the `FileInterceptor` accepts, applied at
 * decoration time (multer cannot read DI). Matches OpenAI's Whisper 25 MiB cap; a
 * lower operator override (`STT_MAX_UPLOAD_BYTES`) is enforced additionally inside
 * {@link GatewayChatV2Service.transcriptions} (so the configured limit is always
 * honored, never only this hard cap).
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
 * OpenAI-compatible speech-to-text: `POST /v1/audio/transcriptions`
 * (multipart/form-data), served END TO END by the NEW supply gateway
 * ({@link GatewayChatV2Service}): the audio part rides the §9.4 media input
 * path, the multipart text fields ride raw into the facade.
 *
 * 批次6 D2: the 切换预案②③ gray-release branch is collapsed — always-new.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/audio')
export class TranscriptionsController {
  constructor(private readonly gatewayV2: GatewayChatV2Service) {}

  @Post('transcriptions')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'OpenAI-compatible speech-to-text (billed per audio second)' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_MAX_UPLOAD_BYTES } }))
  async create(
    @UploadedFile() file: UploadedAudio | undefined,
    // The non-file multipart fields parsed by multer land on `req.body` as
    // strings; the gateway facade validates them.
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | string | undefined> {
    return this.gatewayV2.transcriptions(
      file,
      (req.body ?? {}) as Record<string, unknown>,
      req,
      res,
    );
  }
}
