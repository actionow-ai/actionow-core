// apps/api/src/gateway/create.controller.ts
//
// model-supply-greenfield 批次4 slice3 — the §5 task-paradigm CREATE face:
// resource-style `POST /v1/videos/generations` + `POST /v1/audio/music`, and
// the generic `POST /v1/tasks` (operation rides body.type). One shared flow:
//
//   §2.6 key model-allowlist → §2.1 visibility-gated model resolution → §4.1
//   layer-1 facade 归一 → executeGateway → dispatch on ExecuteResult.kind:
//
//   kind='sync'   → 200 (fast model on a sync-capable operation)
//   kind='task'   → 202 + Task (task paradigm — including §3 自动升格, which
//                   executeGateway/planParadigm already decided SERVER-SIDE;
//                   this controller never re-judges slow/升格)
//   kind='stream' → SSE (IR frames delta/usage/done/error, pre-commit intact)
//   kind='replay' → §5 same-key-same-body: the recorded task answers (202
//                   while live, 200 once terminal)
//   kind='error'  → the §9.3 envelope (conflict→409, rate_limited→429+Retry-
//                   After, model_not_found→404, insufficient_credits→402,
//                   unsupported_parameter→400 …)
//
// Governance: ONLY ApiKeyGuard mounts here (择稳裁决 — see gateway.service.ts:
// the §7.8 gates inside planExecution own the new-world 限流; mounting the
// legacy GovernanceGuard would double-enforce).
import type { GatewayInvokeResponse, GatewayResponse, Operation } from '@actionow/contracts';
import {
  gatewayResourceCreateBodySchema,
  gatewayTaskCreateBodySchema,
  TERMINAL_TASK_STATUSES,
} from '@actionow/contracts';
import type { ExecuteResult } from '@actionow/engine';
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { ApiKeyContext, AuthedRequest } from '../auth/api-key.guard.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ZodBody } from '../common/zod.pipe.js';
import { toGatewayRequest } from './facade.js';
import { GatewayService } from './gateway.service.js';
import { applyDeprecationHeaders, requestIdOf, sendGatewayError } from './gateway-error.js';
import { toTaskView } from './task-view.js';

const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

/** A create body after the wire-envelope zod parse (params stay passthrough). */
type CreateBody = Record<string, unknown> & { model: string };

@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class GatewayCreateController {
  constructor(private readonly gateway: GatewayService) {}

  /** §5 资源风格: video generation (task paradigm → 202 + Task). */
  @Post('videos/generations')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a video generation (202 + Task; fast models may answer 200)' })
  async createVideo(
    @Body(new ZodBody(gatewayResourceCreateBodySchema)) body: CreateBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.create('video.generation', body, req, res);
  }

  /** §5 资源风格: music generation (task paradigm → 202 + Task). */
  @Post('audio/music')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a music generation (202 + Task; fast models may answer 200)' })
  async createMusic(
    @Body(new ZodBody(gatewayResourceCreateBodySchema)) body: CreateBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return this.create('music.generation', body, req, res);
  }

  /** §5 语法糖: generic task create — the operation rides `body.type`. */
  @Post('tasks')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a task (generic; operation = body.type)' })
  async createTask(
    @Body(new ZodBody(gatewayTaskCreateBodySchema)) body: CreateBody & { type: Operation },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    // `type` stays IN the body for the §5 fingerprint (same wire bytes ⇒ same
    // fingerprint); the facade treats it as an envelope key, never a param.
    return this.create(body.type, body, req, res);
  }

  // --- the one shared create flow ------------------------------------------------

  private async create(
    operation: Operation,
    body: CreateBody,
    req: Request,
    res: Response,
  ): Promise<unknown> {
    const requestId = requestIdOf(req);
    const auth = this.authOf(req, res, requestId);
    if (auth === undefined) return undefined;

    // §2.6 key model-allowlist ([] = allow all). An excluded model answers
    // model_not_found — indistinguishable from a missing/ungranted one.
    const allowlist = await this.gateway.modelAllowlist(auth.apiKeyId);
    if (allowlist.length > 0 && !allowlist.includes(body.model)) {
      this.modelNotFound(res, body.model, requestId);
      return;
    }

    // §2.1/§10 visibility gate (also re-run inside the planner — this read is
    // what hands the facade its canonical contract).
    const model = await this.gateway.resolveVisibleModel(body.model, auth.tenantId);
    if (model === undefined) {
      this.modelNotFound(res, body.model, requestId);
      return;
    }

    const contract = model.operations.find((op) => op.operation === operation);
    if (contract === undefined) {
      sendGatewayError(
        res,
        {
          code: 'invalid_input',
          message: `model '${model.name}' does not expose operation '${operation}'`,
          retryable: false,
          failover: false,
        },
        requestId,
      );
      return undefined;
    }

    // §4.1 layer 1 — canonical 归一 (isDefault marking; NO offering semantics).
    const parsed = toGatewayRequest({
      operation,
      modelName: model.name,
      contract,
      body,
      auth: {
        tenantId: auth.tenantId,
        apiKeyId: auth.apiKeyId,
        ...(auth.subjectId !== null ? { subjectId: auth.subjectId } : {}),
      },
      idempotencyKey: idempotencyKeyHeader(req),
      routeTag: routeTagHeader(req),
    });
    if (!parsed.ok) {
      sendGatewayError(res, parsed.error, requestId);
      return undefined;
    }

    const result = await this.gateway.execute(parsed.request, {
      accountId: auth.accountId,
      keyRpm: auth.rateLimit,
      ...(auth.routeGroupId !== null ? { routeGroupId: auth.routeGroupId } : {}),
    });

    applyDeprecationHeaders(res, result.deprecation);
    switch (result.kind) {
      case 'sync':
        // 200 via @HttpCode — the §3 fast path (or an auto-upgrade that judged fast).
        return renderInvokeResponse(result.response);
      case 'task': {
        // §3: the task paradigm (incl. server-side 自动升格) answers 202 + Task.
        // fetch=direct at-most-once: the long-blocking runner is fire-and-forget
        // IN THIS PROCESS (it settles/fails the row itself; a crash leaves
        // running+direct for slice4 recovery to fail WITHOUT charge).
        if (result.run !== undefined) {
          void result.run().catch(() => {
            // runDirectTask already routed the failure into the task row.
          });
        }
        res.status(202);
        return toTaskView(result.task);
      }
      case 'replay':
        // §5 同键同体回放: the recorded task answers — 202 while live (matches
        // the original 202), 200 once terminal (the result is ready).
        res.status(TERMINAL.includes(result.task.status) ? 200 : 202);
        return toTaskView(result.task);
      case 'stream':
        await streamFrames(res, result);
        return undefined;
      case 'error':
        sendGatewayError(res, result.error, requestId);
        return undefined;
    }
  }

  /**
   * The guard-attached auth context. The NEW gateway face requires a REAL api
   * key: the frozen IR makes `apiKeyId` mandatory ((tenant, key) idempotency
   * scope + task attribution FK), so the dev x-tenant-id fallback is rejected.
   */
  private authOf(
    req: Request,
    res: Response,
    requestId: string,
  ): (ApiKeyContext & { apiKeyId: string }) | undefined {
    const auth = (req as AuthedRequest).auth;
    if (auth?.apiKeyId == null) {
      sendGatewayError(
        res,
        {
          code: 'unauthorized',
          message: 'the gateway requires an API key',
          retryable: false,
          failover: false,
        },
        requestId,
      );
      return undefined;
    }
    return { ...auth, apiKeyId: auth.apiKeyId };
  }

  private modelNotFound(res: Response, model: string, requestId: string): undefined {
    sendGatewayError(
      res,
      {
        code: 'model_not_found',
        message: `model '${model}' does not exist or is not available`,
        retryable: false,
        failover: false,
      },
      requestId,
    );
    return undefined;
  }
}

/** GatewayResponse (IR) → the §5 sync 200 wire body (snake_case usage/served_by). */
function renderInvokeResponse(response: GatewayResponse): GatewayInvokeResponse {
  return {
    operation: response.operation,
    model: response.model,
    output: response.output,
    usage: {
      metrics: response.usage.metrics,
      billing_dims: response.usage.billingDims,
      estimated: response.usage.estimated,
    },
    served_by: {
      offering_id: response.servedBy.offeringId,
      channel_id: response.servedBy.channelId,
      ...(response.servedBy.provider !== undefined ? { provider: response.servedBy.provider } : {}),
      ...(response.servedBy.upstreamModelName !== undefined
        ? { upstream_model_name: response.servedBy.upstreamModelName }
        : {}),
    },
    warnings: response.warnings,
  };
}

/**
 * Deliver a kind='stream' result over SSE. The engine's settling stream
 * REPLAYS the pre-commit first frame, then the rest, and settles EXACTLY once
 * on drain/disconnect — so this writer's ONLY jobs are framing and making the
 * iterator's `finally` run on client disconnect (the run.controller 范式).
 * Frames are the normalized IR StreamFrame objects (`kind` = SSE event name);
 * client-dialect rendering (OpenAI chunks …) is the slice6 facade's.
 */
async function streamFrames(
  res: Response,
  result: Extract<ExecuteResult, { kind: 'stream' }>,
): Promise<void> {
  const iterator = result.frames[Symbol.asyncIterator]();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.on('close', () => {
    void iterator.return?.(undefined);
  });

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true || res.writableEnded) break;
      res.write(`event: ${next.value.kind}\n`);
      res.write(`data: ${JSON.stringify(next.value)}\n\n`);
    }
  } finally {
    // Finalize on normal break too — the settling stream's finally is
    // idempotent with the close-handler return above.
    void iterator.return?.(undefined);
    if (!res.writableEnded) res.end();
  }
}
