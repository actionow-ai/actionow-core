// apps/api/src/gateway/tasks.controller.ts
//
// model-supply-greenfield 批次4 slice3 — the §5 task QUERY family:
// GET /v1/tasks (keyset list, status/type filters), GET /v1/tasks/:id (404
// task_not_found under tenant/subject isolation), POST /v1/tasks/:id/cancel
// (§7.7 local mark + hold release; upstream forward = slice4), and
// GET /v1/tasks/:id/stream (SSE progress, DB-poll backstop). Errors render
// the §9.3 gateway envelope.
import type { TaskStatus } from '@actionow/contracts';
import { OPERATIONS, TASK_STATUSES } from '@actionow/contracts';
import { Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { AuthedRequest } from '../auth/api-key.guard.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { mapPageEnvelope, toPageParams } from '../common/pagination.js';
import { requestIdOf, sendGatewayError } from './gateway-error.js';
import { GatewayTaskStreamService } from './task-stream.service.js';
import { toTaskView } from './task-view.js';
import { GatewayTasksService, type TaskScope } from './tasks.service.js';

@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/tasks')
export class GatewayTasksController {
  constructor(
    private readonly tasks: GatewayTasksService,
    private readonly stream: GatewayTaskStreamService,
  ) {}

  /** List the caller's tasks newest-first (§5 游标分页; `type` = operation surface). */
  @Get()
  @ApiOperation({ summary: 'List your tasks (keyset; ?status= & ?type= filters)' })
  async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const requestId = requestIdOf(req);
    if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) {
      this.invalid(res, `unknown status '${status}'`, requestId);
      return;
    }
    if (type !== undefined && !(OPERATIONS as readonly string[]).includes(type)) {
      this.invalid(res, `unknown task type '${type}'`, requestId);
      return;
    }
    const page = await this.tasks.list(
      this.scopeOf(req),
      { status: status as TaskStatus | undefined, operation: type },
      toPageParams({ cursor, limit }),
    );
    return mapPageEnvelope(page, (row) => row.id, toTaskView);
  }

  /** Fetch one task (tenant/subject isolated — an unowned id is a 404). */
  @Get(':id')
  @ApiOperation({ summary: 'Get a task by id' })
  async get(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const requestId = requestIdOf(req);
    const row = await this.tasks.get(id, this.scopeOf(req));
    if (row === undefined) {
      this.notFound(res, id, requestId);
      return;
    }
    return toTaskView(row);
  }

  /**
   * §7.7 cancel: local terminal mark + hold release (upstream cancel forward
   * is slice4's; 晚到结果丢弃 holds via the terminal-state transition guard).
   * Idempotent on an already-`canceled` task (200); any other terminal state
   * is a 409 conflict.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a task (local mark + hold release)' })
  async cancel(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const requestId = requestIdOf(req);
    const outcome = await this.tasks.cancel(id, this.scopeOf(req));
    switch (outcome.kind) {
      case 'ok':
        return toTaskView(outcome.task);
      case 'not_found': {
        this.notFound(res, id, requestId);
        return;
      }
      case 'conflict':
        sendGatewayError(
          res,
          {
            code: 'conflict',
            message: `task ${id} is already terminal ('${outcome.task.status}') and cannot be canceled`,
            retryable: false,
            failover: false,
            details: { status: outcome.task.status },
          },
          requestId,
        );
        return undefined;
    }
  }

  /**
   * SSE progress until terminal (§5 承接现 /v1/jobs SSE). The ownership check
   * runs BEFORE any byte — an unowned task 404s exactly like GET /v1/tasks/:id.
   */
  @Get(':id/stream')
  @ApiOperation({ summary: 'Stream task progress over SSE until terminal' })
  async streamTask(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const requestId = requestIdOf(req);
    const scope = this.scopeOf(req);
    const row = await this.tasks.get(id, scope);
    if (row === undefined) {
      this.notFound(res, id, requestId);
      return;
    }
    await this.stream.streamTo(res, row, scope);
  }

  // --- helpers -------------------------------------------------------------------

  private scopeOf(req: Request): TaskScope {
    const auth = (req as AuthedRequest).auth;
    return {
      tenantId: auth?.tenantId ?? '',
      ...(auth?.subjectId != null ? { subjectId: auth.subjectId } : {}),
    };
  }

  private notFound(res: Response, id: string, requestId: string): undefined {
    sendGatewayError(
      res,
      {
        code: 'task_not_found',
        message: `task ${id} does not exist`,
        retryable: false,
        failover: false,
      },
      requestId,
    );
    return undefined;
  }

  private invalid(res: Response, message: string, requestId: string): undefined {
    sendGatewayError(
      res,
      { code: 'invalid_input', message, retryable: false, failover: false },
      requestId,
    );
    return undefined;
  }
}
