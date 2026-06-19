import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthedRequest } from '../auth/api-key.guard.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { type PageEnvelope, toPageParams } from '../common/pagination.js';
import type { ResourceDetail, ResourceSummary } from './resources.service.js';
import { ResourcesService } from './resources.service.js';

/**
 * Public resource-discovery surface (§4.5). Authenticated by {@link ApiKeyGuard}
 * (no rate-limit guard — these are cheap read-only catalog reads). Results are
 * scoped to the caller's tenant and the API key's `resourceAllowlist`, both
 * enforced in {@link ResourcesService}.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/resources')
export class ResourcesController {
  constructor(
    private readonly resources: ResourcesService,
    private readonly auth: AuthService,
  ) {}

  /** List the resources visible to the caller (tenant + allowlist filtered, paginated). */
  @Get()
  @ApiOperation({ summary: 'List resources visible to the caller (paginated)' })
  async list(
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ResourceSummary>> {
    const ctx = this.auth.resolve(req);
    return this.resources.list(ctx, allowlistOf(req), toPageParams({ cursor, limit }));
  }

  /** Fetch a single resource (with io_schema + pricing). 404 when not visible. */
  @Get(':id')
  @ApiOperation({ summary: 'Fetch a resource (io_schema + pricing)' })
  async get(@Param('id') id: string, @Req() req: Request): Promise<ResourceDetail> {
    const ctx = this.auth.resolve(req);
    return this.resources.get(id, ctx, allowlistOf(req));
  }
}

/** The API key's `resourceAllowlist` the guard attached to the request. */
function allowlistOf(req: Request): readonly string[] {
  return (req as AuthedRequest).auth?.resourceAllowlist ?? [];
}
