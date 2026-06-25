import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type ImagesGenerationDto, imagesGenerationSchema } from './dto/media-dialect.dto.js';
import { type ImagesResponse, MediaDialectService } from './media-dialect.service.js';

/**
 * OpenAI-compatible image generation: `POST /v1/images/generations`. A downstream
 * caller can point the OpenAI SDK's `base_url` here and call
 * `client.images.generate(...)` unchanged. Synchronous over actionow's async
 * `image-relay` (the service drives the job to terminal in-process), billed per
 * image, with the output persisted to object storage.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/images')
export class ImagesController {
  constructor(
    private readonly media: MediaDialectService,
    private readonly auth: AuthService,
  ) {}

  @Post('generations')
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible image generation (relays image-relay)' })
  async generations(
    @Body(new ZodBody(imagesGenerationSchema)) dto: ImagesGenerationDto,
    @Req() req: Request,
  ): Promise<ImagesResponse> {
    const ctx = this.auth.resolve(req);
    return this.media.images(dto, ctx, routeTagHeader(req));
  }
}
