import { Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { type PageEnvelope, toPageParams } from '../common/pagination.js';
import { JobStreamService } from './job-stream.service.js';
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
    private readonly jobStream: JobStreamService,
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

  /**
   * Stream a job's status/progress as Server-Sent Events until it is terminal,
   * then close. Emits `snapshot` (the current view), `progress` (interim status
   * changes), and a terminal `done` (succeeded) / `error` (failed/canceled).
   * Inherits the class `@UseGuards(ApiKeyGuard)`; the ownership check runs before
   * any byte is written, so an unowned job 404s exactly like `GET /v1/jobs/:id`.
   */
  @Get(':id/stream')
  @ApiOperation({ summary: 'Stream a job’s progress over SSE until terminal' })
  async stream(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const ctx = this.auth.resolve(req);
    await this.jobStream.streamTo(res, id, ctx);
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
