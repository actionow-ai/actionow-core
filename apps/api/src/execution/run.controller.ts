import type { StreamEvent, UnifiedError } from '@actionow/contracts';
import type { RunOutcome } from '@actionow/engine';
import { Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ZodBody } from '../common/zod.pipe.js';
import type { RunBody } from './run.service.js';
import { RunBodySchema, RunService } from './run.service.js';

/** The 200 (sync) or 202 (async) response body for `POST /v1/run/:resourceId`. */
interface RunResponse {
  job_id: string;
  status: RunOutcome['status'];
  output?: Record<string, unknown>;
  usage?: Record<string, number>;
  cost?: { credits: string };
}

// ApiKeyGuard authenticates the request and sets req.auth; GovernanceGuard runs
// second (guards execute in declaration order) and reads the authenticated
// tenant + the key's rate limit off req.auth.
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/run')
export class RunController {
  constructor(
    private readonly runService: RunService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Execute a resource. With `Accept: text/event-stream` the run streams over
   * SSE (`delta`/`usage`/`done`/`error` frames); otherwise a blocking run
   * returns 200 with output/usage/cost and an async run returns 202
   * `{status:'queued'}`. Errors map to the §4.7 envelope by the global
   * {@link UnifiedErrorFilter}.
   *
   * The 202 is set imperatively (NestJS defaults POST to 201) only on the queued
   * branch so the synchronous branch keeps its 200.
   */
  @Post(':resourceId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run a resource (blocking → 200, async → 202, SSE stream)' })
  async run(
    @Param('resourceId') resourceId: string,
    @Body(new ZodBody(RunBodySchema)) body: RunBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RunResponse | undefined> {
    const ctx = this.auth.resolve(req);
    // 染色/标签路由: the `X-Actionow-Route-Tag` canary header narrows routing to
    // tag-carrying channels (undefined when blank/absent → unchanged).
    const routeTag = routeTagHeader(req);

    if (wantsEventStream(req)) {
      // Manual `@Res()` SSE: the hold runs in runStream BEFORE we touch the
      // response, so an insufficient_credits / invalid_input throw surfaces as a
      // real HTTP 402/400 via the UnifiedErrorFilter (no SSE bytes written yet).
      // Only after a successful hold do we set the SSE headers and stream.
      await this.streamRun(resourceId, body, req, res);
      return undefined;
    }

    const outcome = await this.runService.run(resourceId, body, ctx, routeTag);

    if (outcome.status === 'queued') {
      res.status(202);
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

  /**
   * Drive a `stream`-mode run over SSE. `runStream` performs the hold first (a
   * throw is mapped to 402/400 before any byte). We then set the SSE headers,
   * write one frame per {@link StreamEvent}, and — critically — guarantee the
   * generator's `finally` runs (settling the job exactly once) on BOTH normal
   * completion AND client disconnect by `return()`-ing the iterator on
   * `res.on('close')`.
   */
  private async streamRun(
    resourceId: string,
    body: RunBody,
    req: Request,
    res: Response,
  ): Promise<void> {
    const ctx = this.auth.resolve(req);
    // 染色/标签路由: the canary header narrows routing to tag-carrying channels
    // (undefined when blank/absent → unchanged); the hold's invalid_input
    // zero-match throw still surfaces as HTTP 400 before any SSE byte.
    const routeTag = routeTagHeader(req);
    const { events } = await this.runService.runStream(resourceId, body, ctx, routeTag);
    const iterator = events[Symbol.asyncIterator]();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx) so frames flush immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // On client disconnect, end the generator → its `finally` settles the job
    // exactly once (idempotent with the normal-completion settle below). The
    // pending `iterator.next()` then resolves `done`, ending the loop.
    res.on('close', () => {
      void iterator.return?.(undefined);
    });

    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true || res.writableEnded) break;
        writeSseFrame(res, next.value);
      }
    } catch (err) {
      // The generator already settled (failJob) before re-throwing. Surface a
      // terminal `error` frame if the socket is still open, then end.
      if (!res.writableEnded) {
        writeSseFrame(res, errorEvent(err));
      }
    } finally {
      // Ensure the generator is finalized even on a normal break (its `finally`
      // settles; idempotent if `res.on('close')` already returned it).
      void iterator.return?.(undefined);
      if (!res.writableEnded) res.end();
    }
  }
}

/** True when the caller asked for an SSE stream via the Accept header. */
function wantsEventStream(req: Request): boolean {
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value.includes('text/event-stream');
}

/** Write one SSE frame: `event: <kind>` + a single `data:` JSON line. */
function writeSseFrame(res: Response, ev: StreamEvent): void {
  res.write(`event: ${ev.kind}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** Build a terminal `error` StreamEvent from a thrown value (sanitized). */
function errorEvent(err: unknown): StreamEvent {
  if (typeof err === 'object' && err !== null && 'unified' in err) {
    const unified = err.unified;
    if (typeof unified === 'object' && unified !== null) {
      return { kind: 'error', error: unified as UnifiedError };
    }
  }
  return {
    kind: 'error',
    error: { code: 'internal_error', message: 'stream error', retryable: false },
  };
}
