import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type AudioSpeechDto, audioSpeechSchema } from './dto/media-dialect.dto.js';
import { MediaDialectService } from './media-dialect.service.js';

/**
 * OpenAI-compatible text-to-speech: `POST /v1/audio/speech`. Like OpenAI, a
 * sync result's response body is the RAW AUDIO BYTES (binary, `audio/*`
 * content type). 批次6 D2: served by the NEW supply gateway (operation `tts`);
 * a slow-marked model answers 202 + Task JSON instead (§3 自动升格). The
 * service owns the response end-to-end (binary vs JSON), so no passthrough.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/audio')
export class AudioController {
  constructor(private readonly media: MediaDialectService) {}

  @Post('speech')
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible text-to-speech (supply gateway; binary audio)' })
  async speech(
    @Body(new ZodBody(audioSpeechSchema)) dto: AudioSpeechDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.media.speech(dto, req, res);
  }
}
