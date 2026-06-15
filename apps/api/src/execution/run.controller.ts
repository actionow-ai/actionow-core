import type { RunOutcome } from '@actionow/engine';
import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { AuthService } from '../auth/auth.service.js';
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
  async run(
    @Param('resourceId') resourceId: string,
    @Body() body: RunBody,
    @Req() req: Request,
  ): Promise<RunResponse> {
    const ctx = await this.auth.resolve(req);
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
