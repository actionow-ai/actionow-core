// apps/api/src/gateway/chat-v2.service.ts
//
// model-supply-greenfield 批次5 slice3+slice6 — 切换预案③: the NEW-gateway
// handler for the LEGACY sync surfaces, plus the 预案② per-tenant gray-release
// decision the old controllers branch on at their ENTRY line (双面并存: flag
// true ⇒ this service end-to-end over the pure new gateway; flag false ⇒ the
// untouched legacy relay path — the two worlds never bridge).
//
// slice3 delivered the OpenAI pair (`POST /v1/chat/completions`,
// `POST /v1/embeddings`); slice6 completes the 7/7 cutover with the remaining
// five legacy faces, each a SurfaceSpec over the SAME serve flow:
//
//   anthropic.messages          POST /v1/messages          → chat.completions
//   gemini.generateContent      POST /v1beta/models/{m}:generateContent
//   gemini.streamGenerateContent POST …:streamGenerateContent (stream forced)
//   rerank                      POST /v1/rerank            → rerank
//   moderations                 POST /v1/moderations       → moderations
//   transcriptions              POST /v1/audio/transcriptions (multipart) → asr
//
// Flow per request (the create.controller 范式, rendered to the surface wire):
//   auth (REAL api key required — the frozen IR mandates apiKeyId) → §2.6 key
//   model-allowlist → §2.1/§10 visibility-gated model resolution → §4.1
//   layer-1 facade 归一 → gateway.execute → dispatch on ExecuteResult.kind:
//
//   kind='sync'   → 200, the surface's wire JSON (transcriptions: the
//                   client-requested response_format, `text` ⇒ a raw string)
//   kind='stream' → the surface's SSE dialect (OpenAI chunks + [DONE];
//                   Anthropic typed events; Gemini alt=sse candidates —
//                   pre-commit intact: execute() returns only after the first
//                   upstream frame; mid-stream failures are in-band dialect
//                   error frames)
//   kind='error'  → the surface's error envelope (OpenAI
//                   `{error:{message,type,param,code}}`; Anthropic
//                   `{type:'error',error:{…}}`; Gemini `{error:{code,message,
//                   status}}`), status from the frozen taxonomy
//   kind='replay' → §5 同键同体: terminal succeeded re-renders the recorded
//                   output as the wire JSON; failed re-answers the recorded
//                   error; a still-live original answers 409 (a sync surface
//                   has no 202 vocabulary for "in flight")
//   kind='task'   → 202 + Task (only reachable when the catalog marks the
//                   operation slow — §3 自动升格 is a pure server-side product
//                   ruling; SDK submit-and-wait consumes the dual shape)
//
// Governance note: the old controllers keep their ApiKeyGuard+GovernanceGuard
// mounts (旧面零改), so a flag=true request passes the LEGACY guard before
// reaching this service AND the new §7.8 gates inside planExecution. That is
// the documented migration-window overlap (stricter-of-both, fail-closed);
// the guard double-mount dies with the old world (slice5 删除).
import type {
  GatewayError,
  GatewayRequest,
  ModelOperation,
  Operation,
  StreamFrame,
} from '@actionow/contracts';
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
import {
  renderAnthropicMessage,
  renderAnthropicMessageOf,
  renderAnthropicMessagesSse,
  sendAnthropicError,
} from './anthropic-render.js';
import { anthropicToGatewayRequest, geminiToGatewayRequest } from './chat-dialect-facade.js';
import type { OpenAIFacadeInput, UploadedAudioFile } from './chat-facade.js';
import {
  chatToGatewayRequest,
  embeddingsToGatewayRequest,
  moderationsToGatewayRequest,
  rerankToGatewayRequest,
  transcriptionsToGatewayRequest,
} from './chat-facade.js';
import type { FacadeAuth, FacadeResult } from './facade.js';
import type { GatewayLimitBindings } from './gateway.service.js';
import { GatewayService } from './gateway.service.js';
import { applyDeprecationHeaders, requestIdOf } from './gateway-error.js';
import {
  renderGeminiResponse,
  renderGeminiResponseOf,
  renderGeminiSse,
  sendGeminiError,
} from './gemini-render.js';
import { isGatewayV2Tenant } from './gray-release.js';
import {
  renderChatCompletion,
  renderChatCompletionChunks,
  renderChatCompletionOf,
  renderEmbeddingsList,
  renderEmbeddingsListOf,
  renderModerations,
  renderModerationsOf,
  renderRerank,
  renderRerankOf,
  renderTranscription,
  renderTranscriptionOf,
  sendOpenAIError,
} from './openai-render.js';
import { toTaskView } from './task-view.js';

const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

/** One legacy sync surface on the new gateway: facade + renderers + error dialect. */
interface SurfaceSpec {
  /** The §2.1 operation the model contract is looked up under. */
  operation: Operation;
  facade: (input: OpenAIFacadeInput) => FacadeResult;
  renderSync: (
    result: Extract<ExecuteResult, { kind: 'sync' }>,
    body: Record<string, unknown>,
  ) => Record<string, unknown> | string;
  renderReplay: (
    task: TaskRow,
    model: string,
    body: Record<string, unknown>,
  ) => Record<string, unknown> | string;
  /**
   * The surface's SSE dialect. Sync-only surfaces keep the OpenAI chunk
   * renderer as a harmless guard — their facades never set `options.stream`,
   * so kind='stream' is unreachable for them.
   */
  renderStream: (frames: AsyncIterable<StreamFrame>, model: string) => AsyncIterable<string>;
  sendError: (res: Response, error: GatewayError, requestId: string) => void;
}

/** The client-requested transcription shape off the multipart text fields. */
function transcriptionFormatOf(body: Record<string, unknown>): string | undefined {
  const format = body.response_format ?? body.responseFormat;
  return typeof format === 'string' ? format : undefined;
}

const SURFACES = {
  'chat.completions': {
    operation: 'chat.completions',
    facade: chatToGatewayRequest,
    renderSync: (result) => renderChatCompletion(result.response),
    renderReplay: (task, model) =>
      renderChatCompletionOf(task.output, task.usage ?? undefined, model),
    renderStream: renderChatCompletionChunks,
    sendError: sendOpenAIError,
  },
  embeddings: {
    operation: 'embeddings',
    facade: embeddingsToGatewayRequest,
    renderSync: (result) => renderEmbeddingsList(result.response),
    renderReplay: (task, model) =>
      renderEmbeddingsListOf(task.output, task.usage ?? undefined, model),
    renderStream: renderChatCompletionChunks,
    sendError: sendOpenAIError,
  },
  'anthropic.messages': {
    operation: 'chat.completions',
    facade: anthropicToGatewayRequest,
    renderSync: (result) => renderAnthropicMessage(result.response),
    renderReplay: (task, model) =>
      renderAnthropicMessageOf(task.output, task.usage ?? undefined, model),
    renderStream: renderAnthropicMessagesSse,
    sendError: sendAnthropicError,
  },
  'gemini.generateContent': {
    operation: 'chat.completions',
    facade: (input) => geminiToGatewayRequest(input, false),
    renderSync: (result) => renderGeminiResponse(result.response),
    renderReplay: (task) => renderGeminiResponseOf(task.output, task.usage ?? undefined),
    renderStream: renderGeminiSse,
    sendError: sendGeminiError,
  },
  'gemini.streamGenerateContent': {
    operation: 'chat.completions',
    facade: (input) => geminiToGatewayRequest(input, true),
    renderSync: (result) => renderGeminiResponse(result.response),
    renderReplay: (task) => renderGeminiResponseOf(task.output, task.usage ?? undefined),
    renderStream: renderGeminiSse,
    sendError: sendGeminiError,
  },
  rerank: {
    operation: 'rerank',
    facade: rerankToGatewayRequest,
    renderSync: (result) => renderRerank(result.response),
    renderReplay: (task, model) => renderRerankOf(task.output, task.usage ?? undefined, model),
    renderStream: renderChatCompletionChunks,
    sendError: sendOpenAIError,
  },
  moderations: {
    operation: 'moderations',
    facade: moderationsToGatewayRequest,
    renderSync: (result) => renderModerations(result.response),
    renderReplay: (task, model) => renderModerationsOf(task.output, model),
    renderStream: renderChatCompletionChunks,
    sendError: sendOpenAIError,
  },
  // `facade` is bound per request (the audio part rides in); see transcriptions().
  transcriptions: {
    operation: 'asr',
    facade: (): FacadeResult => {
      throw new Error('transcriptions facade must be bound per request');
    },
    renderSync: (result, body) => renderTranscription(result.response, transcriptionFormatOf(body)),
    renderReplay: (task, _model, body) =>
      renderTranscriptionOf(task.output, transcriptionFormatOf(body)),
    renderStream: renderChatCompletionChunks,
    sendError: sendOpenAIError,
  },
} satisfies Record<string, SurfaceSpec>;

/** The `model` off a wire body (OpenAI-style surfaces carry it in the body). */
function modelOf(body: Record<string, unknown>): string | null {
  return typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
}

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
  async completions(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serveJson(SURFACES['chat.completions'], modelOf(body), body, req, res);
  }

  /** `POST /v1/embeddings` on the new gateway (flag=true branch). */
  async embeddings(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serveJson(SURFACES.embeddings, modelOf(body), body, req, res);
  }

  /** Anthropic `POST /v1/messages` on the new gateway (flag=true branch). */
  async messages(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serveJson(SURFACES['anthropic.messages'], modelOf(body), body, req, res);
  }

  /** Gemini `POST /v1beta/models/{model}:generateContent` (flag=true branch). */
  async generateContent(
    model: string,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serveJson(
      SURFACES['gemini.generateContent'],
      model.length > 0 ? model : null,
      body,
      req,
      res,
    );
  }

  /**
   * Gemini `POST /v1beta/models/{model}:streamGenerateContent` (flag=true
   * branch). Normally answers alt=sse frames via pipeSse; when the planner
   * legitimately answers sync/replay/task JSON instead (e.g. §3 自动升格), the
   * body is written here — the legacy handler is `void`-shaped, so nothing
   * upstream would send it.
   */
  async streamGenerateContent(
    model: string,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<void> {
    const out = await this.serve(
      SURFACES['gemini.streamGenerateContent'],
      model.length > 0 ? model : null,
      body,
      req,
      res,
    );
    if (out !== undefined && !res.writableEnded) {
      if (typeof out === 'string') res.send(out);
      else res.json(out);
    }
  }

  /** Cohere/Jina `POST /v1/rerank` on the new gateway (flag=true branch). */
  async rerank(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serveJson(SURFACES.rerank, modelOf(body), body, req, res);
  }

  /** OpenAI `POST /v1/moderations` on the new gateway (flag=true branch). */
  async moderations(
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.serveJson(SURFACES.moderations, modelOf(body), body, req, res);
  }

  /**
   * OpenAI `POST /v1/audio/transcriptions` (multipart) on the new gateway
   * (flag=true branch). The audio part is bound into the facade per request
   * (§9.4 media input: base64 mediaRefs + the canonical `file` param); `body`
   * is the multipart TEXT fields (multer strings). A `response_format: 'text'`
   * answer is the raw transcript string (the old-surface contract). The
   * operator upload ceiling (`STT_MAX_UPLOAD_BYTES`) is enforced here below
   * the FileInterceptor's hard cap, as a clean invalid_input.
   */
  async transcriptions(
    file: UploadedAudioFile | undefined,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | string | undefined> {
    const requestId = requestIdOf(req);
    if (file === undefined) {
      sendOpenAIError(res, invalidInput('a multipart "file" part is required'), requestId);
      return undefined;
    }
    const maxBytes = this.env.STT_MAX_UPLOAD_BYTES;
    if (maxBytes !== undefined && file.size > maxBytes) {
      sendOpenAIError(
        res,
        invalidInput(
          `audio upload exceeds the ${String(maxBytes)}-byte limit (${String(file.size)} bytes)`,
        ),
        requestId,
      );
      return undefined;
    }
    const spec: SurfaceSpec = {
      ...SURFACES.transcriptions,
      facade: (input) => transcriptionsToGatewayRequest(input, file),
    };
    return this.serve(spec, modelOf(body), body, req, res);
  }

  // --- the shared serve flow -----------------------------------------------------

  /** serve() for the JSON-object surfaces (everything but transcriptions' text format). */
  private async serveJson(
    spec: SurfaceSpec,
    modelName: string | null,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return (await this.serve(spec, modelName, body, req, res)) as
      | Record<string, unknown>
      | undefined;
  }

  private async serve(
    spec: SurfaceSpec,
    modelName: string | null,
    body: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<Record<string, unknown> | string | undefined> {
    const requestId = requestIdOf(req);

    const auth = this.authOf(req, res, requestId, spec);
    if (auth === undefined) return undefined;

    if (modelName === null) {
      spec.sendError(res, invalidInput("request requires a 'model'"), requestId);
      return undefined;
    }

    // §2.6 key model-allowlist ([] = allow all) — an excluded model answers
    // model_not_found, indistinguishable from a missing/ungranted one.
    const allowlist = await this.gateway.modelAllowlist(auth.apiKeyId);
    if (allowlist.length > 0 && !allowlist.includes(modelName)) {
      spec.sendError(res, modelNotFound(modelName), requestId);
      return undefined;
    }

    // §2.1/§10 visibility gate — this read hands the facade its canonical contract.
    const model = await this.gateway.resolveVisibleModel(modelName, auth.tenantId);
    if (model === undefined) {
      spec.sendError(res, modelNotFound(modelName), requestId);
      return undefined;
    }

    const contract: ModelOperation | undefined = model.operations.find(
      (op) => op.operation === spec.operation,
    );
    if (contract === undefined) {
      spec.sendError(
        res,
        invalidInput(`model '${model.name}' does not expose operation '${spec.operation}'`),
        requestId,
      );
      return undefined;
    }

    // §4.1 layer 1 — wire canonical 归一 (isDefault marking; NO offering semantics).
    const parsed = spec.facade({
      modelName: model.name,
      contract,
      body,
      auth,
      idempotencyKey: idempotencyKeyHeader(req),
      routeTag: routeTagHeader(req),
    });
    if (!parsed.ok) {
      spec.sendError(res, parsed.error, requestId);
      return undefined;
    }

    const result = await this.gateway.execute(parsed.request, {
      accountId: auth.accountId,
      keyRpm: auth.keyRpm,
      ...(auth.routeGroupId !== null ? { routeGroupId: auth.routeGroupId } : {}),
      // 批次6 P5 — the guard-resolved limit-plan bindings feed the §7.8 gates
      // (during the 双面并存 window a flag=true request ALSO passed the legacy
      // GovernanceGuard on the old controller — stricter-of-both; the overlap
      // dies with the guard's deletion).
      limits: auth.limits,
    });

    applyDeprecationHeaders(res, result.deprecation);
    switch (result.kind) {
      case 'sync':
        this.stampServedBy(res, result.response.servedBy);
        return spec.renderSync(result, body);
      case 'stream':
        // Pre-commit already happened inside execute(); frames replay the first
        // frame, then the rest, settling exactly once on drain/disconnect.
        await pipeSse(res, spec.renderStream(result.frames, parsed.request.model));
        return undefined;
      case 'replay':
        return this.renderReplay(spec, result.task, parsed.request, body, res, requestId);
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
        spec.sendError(res, result.error, requestId);
        return undefined;
    }
  }

  /** §5 同键同体回放 on a sync surface (no 202 vocabulary here). */
  private renderReplay(
    spec: SurfaceSpec,
    task: TaskRow,
    request: GatewayRequest,
    body: Record<string, unknown>,
    res: Response,
    requestId: string,
  ): Record<string, unknown> | string | undefined {
    if (task.status === 'succeeded') {
      res.status(200);
      return spec.renderReplay(task, request.model, body);
    }
    if (TERMINAL.includes(task.status)) {
      spec.sendError(
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
    spec.sendError(
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
   * so the dev x-tenant-id fallback is rejected with the surface's wire 401.
   */
  private authOf(
    req: Request,
    res: Response,
    requestId: string,
    spec: SurfaceSpec,
  ):
    | (FacadeAuth & {
        accountId: string;
        keyRpm: number | null;
        routeGroupId: string | null;
        /** 批次6 P5 — the guard-resolved limit-plan bindings (额度套餐). */
        limits: GatewayLimitBindings;
      })
    | undefined {
    const auth = (req as AuthedRequest).auth;
    if (auth?.apiKeyId == null) {
      spec.sendError(
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
      limits: {
        keyLimitPlanId: auth.limitPlanId,
        tenantLimitPlanId: auth.tenantLimitPlanId,
        subjectLimitPlanId: auth.subjectLimitPlanId,
      },
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
