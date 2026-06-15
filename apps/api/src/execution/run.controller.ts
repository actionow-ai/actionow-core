import type { RunOutcome } from '@actionow/engine';
import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import type { RunBody } from './run.service.js';
import { RunService } from './run.service.js';

/** The 200 (sync) or 202 (async) response body for `POST /v1/run/:resourceId`. */
interface RunResponse {
  job_id: string;
  status: RunOutcome['status'];
  output?: Record<string, unknown>;
  usage?: Record<string, number>;
  cost?: { credits: string };
}

// ApiKeyGuard authenticates the request and sets req.auth; RateLimitGuard runs
// second (guards execute in declaration order) and reads the authenticated
// tenant + the key's rate limit off req.auth.
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, RateLimitGuard)
@Controller('v1/run')
export class RunController {
  constructor(
    private readonly runService: RunService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Execute a resource. A blocking run returns 200 with the output/usage/cost;
   * an async run returns 202 with `{status:'queued'}`. Errors are mapped to the
   * §4.7 envelope by the global {@link UnifiedErrorFilter}.
   *
   * The 202 is set imperatively (NestJS defaults POST to 201) only on the
   * queued branch so the synchronous branch keeps its 200.
   */
  @Post(':resourceId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run a resource (blocking → 200, async → 202)' })
  async run(
    @Param('resourceId') resourceId: string,
    @Body() body: RunBody,
    @Req() req: Request,
  ): Promise<RunResponse> {
    const ctx = this.auth.resolve(req);
    const outcome = await this.runService.run(resourceId, body, ctx);

    if (outcome.status === 'queued') {
      req.res?.status(202);
      return { job_id: outcome.jobId, status: 'queued' };
    }

    return {
      job_id: outcome.jobId,
      status: 'succeeded',
      output: outcome.output,
      usage: outcome.usage,
      // µcredits are bigint — serialize as a decimal string so JSON keeps full
      // precision and never coerces money through a float.
      cost: { credits: outcome.cost.credits.toString() },
    };
  }
}
