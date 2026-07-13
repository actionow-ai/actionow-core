// apps/api/src/gateway/chat-v2.service.ts
//
// model-supply-greenfield 批次5 slice3 — 切换预案③: the NEW-gateway handler
// for the LEGACY OpenAI sync surfaces (`POST /v1/chat/completions`,
// `POST /v1/embeddings`), plus the 预案② per-tenant gray-release decision the
// old controllers branch on at their ENTRY line (双面并存: flag true ⇒ this
// service end-to-end over the pure new gateway; flag false ⇒ the untouched
// ChatRelayService/EmbedRelayService path — the two worlds never bridge).
//
// Flow per request (the create.controller 范式, rendered to the OpenAI wire):
//   auth (REAL api key required — the frozen IR mandates apiKeyId) → §2.6 key
//   model-allowlist → §2.1/§10 visibility-gated model resolution → §4.1
//   layer-1 chat/embeddings facade 归一 (chat-facade.ts) → gateway.execute →
//   dispatch on ExecuteResult.kind:
//
//   kind='sync'   → 200 `chat.completion` / embeddings `list` JSON
//   kind='stream' → `chat.completion.chunk` SSE ending `data: [DONE]`
//                   (pre-commit intact: execute() returns only after the first
//                   upstream frame, so the 200 commits on a live upstream;
//                   mid-stream failures are OpenAI error frames WITHOUT [DONE])
//   kind='error'  → the OpenAI `{error:{message,type,param,code}}` envelope
//                   (conflict→409, rate_limited→429+Retry-After,
//                   model_not_found→404, insufficient_credits→402,
//                   unsupported_parameter→400 …)
//   kind='replay' → §5 同键同体: terminal succeeded re-renders the recorded
//                   output as the wire JSON; failed re-answers the recorded
//                   error; a still-live original answers 409 (an OpenAI sync
//                   surface has no 202 vocabulary for "in flight")
//   kind='task'   → 202 + Task (only reachable when the catalog marks the
//                   operation slow — §3 自动升格 is a pure server-side product
//                   ruling; SDK submit-and-wait consumes the dual shape)
//
// Governance note: the old controllers keep their ApiKeyGuard+GovernanceGuard
// mounts (旧面零改), so a flag=true request passes the LEGACY guard before
// reaching this service AND the new §7.8 gates inside planExecution. That is
// the documented migration-window overlap (stricter-of-both, fail-closed);
// the guard double-mount dies with the old world (slice5 删除).
import type { GatewayError, GatewayRequest, ModelOperation } from '@actionow/contracts';
import { TERMINAL_TASK_STATUSES } from '@actionow/contracts';
import type { Database, TaskRow } from '@actionow/db';
import type { ExecuteResult } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthedRequest } from '../auth/api-key.guard.js';
import { pipeSse } from '../chat/sse.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import { DB, ENV } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { chatToGatewayRequest, embeddingsToGatewayRequest } from './chat-facade.js';
import type { FacadeAuth, FacadeResult } from './facade.js';
import { GatewayService } from './gateway.service.js';
import { applyDeprecationHeaders, requestIdOf } from './gateway-error.js';
import { isGatewayV2Tenant } from './gray-release.js';
import {
  renderChatCompletion,
  renderChatCompletionChunks,
  renderChatCompletionOf,
  renderEmbeddingsList,
  renderEmbeddingsListOf,
  sendOpenAIError,
} from './openai-render.js';
import { toTaskView } from './task-view.js';

const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

/** The two OpenAI sync surfaces this service serves (facade + renderers per op). */
type OpenAISurface = 'chat.completions' | 'embeddings';

interface SurfaceRender {
  facade: (input: Parameters<typeof chatToGatewayRequest>[0]) => FacadeResult;
  renderSync: (result: Extract<ExecuteResult, { kind: 'sync' }>) => Record<string, unknown>;
  renderReplay: (task: TaskRow, model: string) => Record<string, unknown>;
}

const SURFACES: Record<OpenAISurface, SurfaceRender> = {
  'chat.completions': {
    facade: chatToGatewayRequest,
    renderSync: (result) => renderChatCompletion(result.response),
    renderReplay: (task, model) =>
      renderChatCompletionOf(task.output, task.usage ?? undefined, model),
  },
  embeddings: {
    facade: embeddingsToGatewayRequest,
    renderSync: (result) => renderEmbeddingsList(result.response),
    renderReplay: (task, model) =>
      renderEmbeddingsListOf(task.output, task.usage ?? undefined, model),
  },
};

@Injectable()
export class GatewayChatV2Service {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly gateway: GatewayService,
    // Global module in the real app; absent in partial test modules → the env
    // GATEWAY_V2_DEFAULT (→ false) decides, matching the gray-release doc.
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /**
   * 预案② — should THIS tenant's legacy sync traffic ride the new gateway?
   * tenant.config.gateway_v2 wins; else GATEWAY_V2_DEFAULT (settings → env →
   * false). Fail-closed: no opinion anywhere ⇒ the old path.
   */
  isV2Tenant(tenantId: string): Promise<boolean> {
    return isGatewayV2Tenant(
      {
        db: this.db,
        getPlatformDefault: async () =>
          (await this.settings?.get('GATEWAY_V2_DEFAULT')) ?? this.env.GATEWAY_V2_DEFAULT ?? false,
      },
      tenantId,
    );
  }

  /** `POST /v1/chat/completions` on the new gateway (flag=true branch). */
  completions(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serve('chat.completions', body, req, res);
  }

  /** `POST /v1/embeddings` on the new gateway (flag=true branch). */
  embeddings(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serve('embeddings', body, req, res);
  }

  // --- the shared serve flow -----------------------------------------------------

  private async serve(
    surface: OpenAISurface,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    const render = SURFACES[surface];
    const requestId = requestIdOf(req);

    const auth = this.authOf(req, res, requestId);
    if (auth === undefined) return undefined;

    const modelName = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
    if (modelName === null) {
      sendOpenAIError(res, invalidInput("request requires a 'model'"), requestId);
      return undefined;
    }

    // §2.6 key model-allowlist ([] = allow all) — an excluded model answers
    // model_not_found, indistinguishable from a missing/ungranted one.
    const allowlist = await this.gateway.modelAllowlist(auth.apiKeyId);
    if (allowlist.length > 0 && !allowlist.includes(modelName)) {
      sendOpenAIError(res, modelNotFound(modelName), requestId);
      return undefined;
    }

    // §2.1/§10 visibility gate — this read hands the facade its canonical contract.
    const model = await this.gateway.resolveVisibleModel(modelName, auth.tenantId);
    if (model === undefined) {
      sendOpenAIError(res, modelNotFound(modelName), requestId);
      return undefined;
    }

    const contract: ModelOperation | undefined = model.operations.find(
      (op) => op.operation === surface,
    );
    if (contract === undefined) {
      sendOpenAIError(
        res,
        invalidInput(`model '${model.name}' does not expose operation '${surface}'`),
        requestId,
      );
      return undefined;
    }

    // §4.1 layer 1 — OpenAI-wire canonical 归一 (isDefault marking; NO offering semantics).
    const parsed = render.facade({
      modelName: model.name,
      contract,
      body,
      auth,
      idempotencyKey: idempotencyKeyHeader(req),
      routeTag: routeTagHeader(req),
    });
    if (!parsed.ok) {
      sendOpenAIError(res, parsed.error, requestId);
      return undefined;
    }

    const result = await this.gateway.execute(parsed.request, {
      accountId: auth.accountId,
      keyRpm: auth.keyRpm,
      ...(auth.routeGroupId !== null ? { routeGroupId: auth.routeGroupId } : {}),
    });

    applyDeprecationHeaders(res, result.deprecation);
    switch (result.kind) {
      case 'sync':
        this.stampServedBy(res, result.response.servedBy);
        return render.renderSync(result);
      case 'stream':
        // Pre-commit already happened inside execute(); frames replay the first
        // frame, then the rest, settling exactly once on drain/disconnect.
        await pipeSse(res, renderChatCompletionChunks(result.frames, parsed.request.model));
        return undefined;
      case 'replay':
        return this.renderReplay(render, result.task, parsed.request, res, requestId);
      case 'task': {
        // §3 自动升格 (slow-marked catalog contract): 202 + Task, pure
        // server-side — the SDK's submit-and-wait consumes the dual shape.
        if (result.run !== undefined) {
          void result.run().catch(() => {
            // runDirectTask already routed the failure into the task row.
          });
        }
        res.status(202);
        return toTaskView(result.task);
      }
      case 'error':
        sendOpenAIError(res, result.error, requestId);
        return undefined;
    }
  }

  /** §5 同键同体回放 on a sync OpenAI surface (no 202 vocabulary here). */
  private renderReplay(
    render: SurfaceRender,
    task: TaskRow,
    request: GatewayRequest,
    res: Response,
    requestId: string,
  ): Record<string, unknown> | undefined {
    if (task.status === 'succeeded') {
      res.status(200);
      return render.renderReplay(task, request.model);
    }
    if (TERMINAL.includes(task.status)) {
      sendOpenAIError(
        res,
        task.error ?? {
          code: 'task_failed',
          message: `the original request for this Idempotency-Key ended '${task.status}'`,
          retryable: false,
          failover: false,
        },
        requestId,
      );
      return undefined;
    }
    sendOpenAIError(
      res,
      {
        code: 'conflict',
        message: 'a request with this Idempotency-Key is still in progress',
        retryable: true,
        failover: false,
      },
      requestId,
    );
    return undefined;
  }

  /**
   * The guard-attached auth context. The new gateway face requires a REAL api
   * key (frozen IR: apiKeyId is mandatory — idempotency scope + attribution),
   * so the dev x-tenant-id fallback is rejected with an OpenAI-wire 401.
   */
  private authOf(
    req: Request,
    res: Response,
    requestId: string,
  ):
    | (FacadeAuth & { accountId: string; keyRpm: number | null; routeGroupId: string | null })
    | undefined {
    const auth = (req as AuthedRequest).auth;
    if (auth?.apiKeyId == null) {
      sendOpenAIError(
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
    return {
      tenantId: auth.tenantId,
      apiKeyId: auth.apiKeyId,
      ...(auth.subjectId !== null ? { subjectId: auth.subjectId } : {}),
      accountId: auth.accountId,
      keyRpm: auth.rateLimit,
      routeGroupId: auth.routeGroupId,
    };
  }

  /** §8 可观测: echo WHICH offering served (new-face headers; providerType parity for the old x-actionow-channel). */
  private stampServedBy(
    res: Response,
    servedBy: { offeringId: string; channelId: string; provider?: string | undefined },
  ): void {
    res.setHeader('x-actionow-offering', servedBy.offeringId);
    if (servedBy.provider !== undefined) res.setHeader('x-actionow-channel', servedBy.provider);
  }
}

// --- error builders --------------------------------------------------------------------

function invalidInput(message: string): GatewayError {
  return { code: 'invalid_input', message, retryable: false, failover: false };
}

function modelNotFound(model: string): GatewayError {
  return {
    code: 'model_not_found',
    message: `model '${model}' does not exist or is not available`,
    retryable: false,
    failover: false,
  };
}
