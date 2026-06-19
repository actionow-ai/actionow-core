import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { type PageEnvelope, toPageParams } from '../common/pagination.js';
import type { JobView } from './jobs.service.js';
import { JobsService } from './jobs.service.js';

@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly auth: AuthService,
  ) {}

  /** List the caller's jobs newest-first, keyset-paginated by `cursor`. */
  @Get()
  @ApiOperation({ summary: 'List the caller’s jobs (keyset, paginated)' })
  async list(
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<JobView>> {
    const ctx = this.auth.resolve(req);
    return this.jobs.list(ctx, toPageParams({ cursor, limit }));
  }

  /** Fetch a single job by id (404 if it is not the caller's). */
  @Get(':id')
  @ApiOperation({ summary: 'Fetch a job by id' })
  async get(@Param('id') id: string, @Req() req: Request): Promise<JobView> {
    const ctx = this.auth.resolve(req);
    return this.jobs.get(id, ctx);
  }

  /** Cancel a queued job (transition → canceled + release hold). */
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a queued job' })
  async cancel(@Param('id') id: string, @Req() req: Request): Promise<JobView> {
    const ctx = this.auth.resolve(req);
    return this.jobs.cancel(id, ctx);
  }
}
