import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import type { JobsPage, JobView } from './jobs.service.js';
import { JobsService } from './jobs.service.js';

const DEFAULT_LIMIT = 50;

@UseGuards(ApiKeyGuard)
@Controller('v1/jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly auth: AuthService,
  ) {}

  /** List the caller's jobs newest-first, keyset-paginated by `cursor`. */
  @Get()
  async list(
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<JobsPage> {
    const ctx = this.auth.resolve(req);
    const parsedLimit = limit === undefined ? DEFAULT_LIMIT : Number.parseInt(limit, 10);
    const effectiveLimit = Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit;
    return this.jobs.list(ctx, cursor, effectiveLimit);
  }

  /** Fetch a single job by id (404 if it is not the caller's). */
  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request): Promise<JobView> {
    const ctx = this.auth.resolve(req);
    return this.jobs.get(id, ctx);
  }

  /** Cancel a queued job (transition → canceled + release hold). */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Req() req: Request): Promise<JobView> {
    const ctx = this.auth.resolve(req);
    return this.jobs.cancel(id, ctx);
  }
}
