import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type AudioSpeechDto, audioSpeechSchema } from './dto/media-dialect.dto.js';
import { MediaDialectService } from './media-dialect.service.js';

/**
 * OpenAI-compatible text-to-speech: `POST /v1/audio/speech`. A downstream caller
 * can point the OpenAI SDK's `base_url` here and call
 * `client.audio.speech.create(...)` unchanged. Like OpenAI, the response body is
 * the RAW AUDIO BYTES (binary, with an `audio/*` content type), so this handler
 * owns the response. Synchronous over actionow's async `audio-relay`. The handler
 * throws BEFORE writing any byte on failure, so the global error filter still
 * renders the §4.7 envelope.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/audio')
export class AudioController {
  constructor(
    private readonly media: MediaDialectService,
    private readonly auth: AuthService,
  ) {}

  @Post('speech')
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible text-to-speech (relays audio-relay; binary audio)' })
  async speech(
    @Body(new ZodBody(audioSpeechSchema)) dto: AudioSpeechDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = this.auth.resolve(req);
    const { bytes, contentType } = await this.media.speech(dto, ctx, routeTagHeader(req));
    const body = Buffer.from(bytes);
    res.status(200);
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(body.byteLength));
    res.end(body);
  }
}
