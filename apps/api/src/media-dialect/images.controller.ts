import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type ImagesGenerationDto, imagesGenerationSchema } from './dto/media-dialect.dto.js';
import { MediaDialectService } from './media-dialect.service.js';

/**
 * OpenAI-compatible image generation: `POST /v1/images/generations`. A downstream
 * caller can point the OpenAI SDK's `base_url` here and call
 * `client.images.generate(...)` unchanged. 批次6 D2: served by the NEW supply
 * gateway (operation `images.generation`) — fast models answer the classic
 * `{created, data:[{url}]}` 200; a slow-marked model auto-upgrades to 202+Task
 * (§3, plan 判据 2.8). Only ApiKeyGuard mounts here — the §7.8 gates inside
 * the gateway own the new-world 限流/额度 (the create.controller 择稳裁决).
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/images')
export class ImagesController {
  constructor(private readonly media: MediaDialectService) {}

  @Post('generations')
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible image generation (supply gateway)' })
  async generations(
    @Body(new ZodBody(imagesGenerationSchema)) dto: ImagesGenerationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.media.images(dto, req, res);
  }
}
