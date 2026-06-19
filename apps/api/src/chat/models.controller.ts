import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { ModelResolverService } from './model-resolver.service.js';

/**
 * OpenAI-compatible model discovery: `GET /v1/models`. Lists the models visible
 * to the authenticated tenant (Track C's `listVisibleModels`: every `active`
 * `public` model plus this tenant's granted `tenant` models), rendered in the
 * OpenAI list shape (`{ object: 'list', data: [{ id, object: 'model', ... }] }`).
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/models')
export class ModelsController {
  constructor(
    private readonly resolver: ModelResolverService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Req() req: Request): Promise<Record<string, unknown>> {
    const ctx = this.auth.resolve(req);
    const models = await this.resolver.listVisible(ctx.tenantId);
    return {
      object: 'list',
      data: models.map((m) => ({ id: m.name, object: 'model', owned_by: 'actionow' })),
    };
  }
}
