import type { AdapterRegistry } from '@actionow/adapters';
import type {
  ChatRequest,
  ExecMode,
  IoSchema,
  Modifier,
  PricebookEntry,
  UsageVector,
} from '@actionow/contracts';
import {
  type Database,
  getModelFallbacks,
  getResource,
  getResourceVersion,
  listApplicableModifiers,
  type ModifierRow,
} from '@actionow/db';
import type {
  BreakerStore,
  ChatRunOutcome,
  ChatStreamOutcome,
  JobQueuePort,
  RunRequest,
} from '@actionow/engine';
import { EngineError, ExecutionService } from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { normalizeRequest, readCapabilities } from '@actionow/llm-protocol';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, BREAKER, DB, ENV, JOB_QUEUE } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModelResolverService, type ResolvedModel } from './model-resolver.service.js';

/** The opaque inputs key under which the IR `ChatRequest` rides into the engine. */
const IR_KEY = '__ir';

/**
 * Placeholder ceiling for `output_tokens` when the IR carries no explicit
 * `maxOutputTokens`. The streaming hold is a `model_token` settle of the
 * estimate (§C1) — the same `roundHalfUp(tokens × ratePer1M / 1e6)` µUSD math
 * as the eventual settle — so this must over-estimate the largest realistic
 * completion; the over-hold is fully refunded at settle when the true usage is
 * observed. Because the estimate's token counts are an upper bound and the
 * per-1M math is monotonic, the hold is always >= the eventual settle for the
 * same usage (never under-holds). Chosen large enough that a normal completion's
 * true cost never exceeds the priced hold (which would otherwise let
 * `settleStream`'s cap clamp the charge).
 */
const ESTIMATE_OUTPUT_TOKENS_CEILING = 32_768;

/**
 * Rough bytes-per-token divisor for the prompt estimate (≈4 bytes/token is the
 * conventional GPT-family heuristic). Only used to size the streaming hold.
 */
const ESTIMATE_BYTES_PER_TOKEN = 4;

/**
 * Padding multiplier applied to the prompt-byte estimate so the input-token
 * hold over-shoots a tight `len/4` count (tokenizers vary by dialect/locale).
 */
const ESTIMATE_INPUT_PADDING = 2;

/**
 * Unified-error codes that trigger MODEL degradation (模型降级链): UPSTREAM-side
 * failures where another model may succeed. Client-side codes (`invalid_input`,
 * `unauthorized`, `content_filtered`, `insufficient_credits`, `resource_not_found`)
 * do NOT fall back — the request itself, or the account, is the problem.
 */
const DEGRADE_CODES: ReadonlySet<string> = new Set([
  'upstream_error',
  'upstream_timeout',
  'rate_limited',
  'job_failed',
]);

/** Whether a failed model attempt should degrade to the next model in the chain. */
function shouldDegradeToNextModel(err: unknown): boolean {
  return err instanceof EngineError && DEGRADE_CODES.has(err.unified.code);
}

/**
 * Funnels each dialect endpoint into the engine: resolves a model name → a chat
 * `resourceId` + capabilities, gates the IR via {@link normalizeRequest}, builds
 * a {@link RunRequest} for that resource (the same catalog loads as
 * `RunService.buildRequest`, but priced via a `model_token` pricebook built from
 * the resolved model's prices), and drives `runChatStream`/`runChat`. The caller
 * (controller) renders the IR response/events back to its wire dialect.
 */
@Injectable()
export class ChatRelayService {
  private readonly http = createHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    @Inject(JOB_QUEUE) private readonly queue: JobQueuePort,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(BREAKER) private readonly breaker: BreakerStore,
    private readonly secrets: SecretResolver,
    private readonly resolver: ModelResolverService,
    private readonly routing: ChannelRoutingService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /**
   * Open an IR-streaming chat run for the resolved model (hold runs first), with
   * MODEL-DEGRADATION fallback (模型降级链) — identical control flow to blocking
   * {@link chat}: walk `chain = [modelName, ...fallback_models]`; on a RETRYABLE
   * pre-commit failure (every channel of a model exhausted BEFORE the stream
   * committed), degrade to the next model. Each attempt is a self-contained
   * `runChatStream` — it holds, opens the upstream + pulls the first event, and
   * on a total pre-commit failure RELEASES its own hold and throws — so attempts
   * never double-charge; only the committed model settles. A non-retryable error
   * (invalid input / content filtered) does NOT fall back. Each attempt uses a
   * distinct idempotency key so a failed claim can't block the next model. Once a
   * stream commits, a later mid-stream error stays in-band (no post-commit
   * failover — bytes are already on the wire).
   */
  async chatStream(
    modelName: string,
    ir: ChatRequest,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<ChatStreamOutcome> {
    const chain = [modelName, ...(await getModelFallbacks(this.db, modelName))];
    let lastError: unknown;
    for (const [i, model] of chain.entries()) {
      const isLast = i === chain.length - 1;
      // Distinct per-attempt idempotency key — a fallback is a NEW upstream op.
      const idem =
        idempotencyKey === undefined || i === 0
          ? idempotencyKey
          : `${idempotencyKey}:fb${String(i)}`;
      try {
        const req = await this.buildChatRunRequest(model, ir, ctx, 'stream', idem, routeTag);
        return await (await this.buildService()).runChatStream(req);
      } catch (err) {
        lastError = err;
        if (isLast || !shouldDegradeToNextModel(err)) throw err;
        // else: this model's stream failed PRE-COMMIT (exhausted/timeout/5xx) → next model.
      }
    }
    throw lastError;
  }

  /**
   * Run a blocking IR chat for the resolved model (hold → chat → settle-once),
   * with MODEL-DEGRADATION fallback (模型降级链): on a RETRYABLE failure (all of
   * a model's channels exhausted), retry with each `fallback_models` name in
   * order. Each attempt is self-contained — `runChat` holds, routes, and either
   * settles or RELEASES the hold on failure — so attempts never double-charge.
   * A non-retryable error (invalid input / content filtered) does NOT fall back.
   * Each attempt uses a distinct idempotency key so a failed claim can't block
   * the next model. Streaming ({@link chatStream}) now walks the SAME chain — a
   * model's total PRE-COMMIT failure degrades to the next model.
   */
  async chat(
    modelName: string,
    ir: ChatRequest,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<ChatRunOutcome> {
    const chain = [modelName, ...(await getModelFallbacks(this.db, modelName))];
    let lastError: unknown;
    for (const [i, model] of chain.entries()) {
      const isLast = i === chain.length - 1;
      // Distinct per-attempt idempotency key — a fallback is a NEW upstream op.
      const idem =
        idempotencyKey === undefined || i === 0
          ? idempotencyKey
          : `${idempotencyKey}:fb${String(i)}`;
      try {
        const req = await this.buildChatRunRequest(model, ir, ctx, 'blocking', idem, routeTag);
        return await (await this.buildService()).runChat(req);
      } catch (err) {
        lastError = err;
        if (isLast || !shouldDegradeToNextModel(err)) throw err;
        // else: this model's upstream failed (exhausted/timeout/5xx) → next model.
      }
    }
    throw lastError;
  }

  /** Construct an {@link ExecutionService} bound to this app's shared deps. */
  private async buildService(): Promise<ExecutionService> {
    const relayTrace = (await this.settings?.get('RELAY_TRACE')) ?? this.env.RELAY_TRACE;
    const traceMaxBytes =
      (await this.settings?.get('RELAY_TRACE_MAX_BYTES')) ?? this.env.RELAY_TRACE_MAX_BYTES;
    return new ExecutionService({
      db: this.db,
      adapters: this.adapters,
      resolveSecret: (ref: string): Promise<string | undefined> => this.secrets.resolve(ref),
      http: this.http,
      now: () => new Date(),
      enqueue: (jobId: string): Promise<void> => this.queue.enqueueExec(jobId),
      proxyUrlEnv: this.env.UPSTREAM_PROXY_URL,
      traceUpstream: relayTrace === 'full',
      traceMaxBytes,
      breaker: this.breaker,
    });
  }

  /**
   * Resolve the model → chat resource, gate the IR against the model's declared
   * capabilities, and load the resource catalog into a {@link RunRequest} that
   * carries the IR at `inputs.__ir`. Pricing is a `model_token` pricebook built
   * from the resolved model's `inputPrice`/`outputPrice` (µUSD per 1M tokens —
   * NOT the resource's own pricebook), and `usageLogModel` is set so the engine
   * mirrors a `usage_log` row on settle.
   */
  private async buildChatRunRequest(
    modelName: string,
    ir: ChatRequest,
    ctx: TenantContext,
    execMode: ExecMode,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<RunRequest> {
    const resolved = await this.resolver.resolve(modelName, ctx.tenantId);
    normalizeRequest(ir, readCapabilities(resolved.capabilities));

    const { resourceId } = resolved;
    const resource = await getResource(this.db, resourceId);
    if (resource === undefined) {
      throw engineNotFound(`chat resource ${resourceId} not found`);
    }
    const version = resource.currentVersion;

    const versionRow = await getResourceVersion(this.db, resourceId, version);
    if (versionRow === undefined) {
      throw engineNotFound(`chat resource ${resourceId} version ${String(version)} not found`);
    }

    // Group-scoped candidate set (Track 4): the key's route group filters which
    // channels of the resource are routable, each carrying its per-(group,channel)
    // priority/weight for the engine's priority-tiered fallback. Falls back to ALL
    // active channels when the group has no members for the resource (compat).
    // 染色/标签路由: `routeTag` (the `X-Actionow-Route-Tag` canary header) narrows
    // the resolved candidates to tag-carrying channels only — never widening, and
    // a zero-match throws a hard 400 inside `candidatesFor` (no silent leak).
    const channels = await this.routing.candidatesFor(
      resourceId,
      ctx.routeGroupId,
      resolved.modelId,
      routeTag,
    );
    if (channels.length === 0) {
      throw engineNotFound(`no active upstream channel for chat resource ${resourceId}`);
    }

    // The CUSTOMER-PRICE ratio (Track 5): resolved pre-routing from the key's
    // group (`route_group.group_ratio_bps`; unbound → the `default` group; no
    // default → ×1.0). Folded into the model_token base BEFORE markup/modifiers,
    // so it applies uniformly to the hold (estimated usage) and the settle.
    const groupRatioBps = await this.routing.groupRatioBpsFor(ctx.routeGroupId);

    const modifierRows = await listApplicableModifiers(this.db, {
      tenantId: ctx.tenantId,
      resourceId,
    });

    const req: RunRequest = {
      resource: {
        id: resource.id,
        version,
        modality: resource.modality,
        ioSchema: versionRow.ioSchema as IoSchema,
        execModes: resource.execModes as ExecMode[],
        providerType: resource.providerType,
      },
      pricebookEntry: this.modelTokenPricebook(resolved, version, groupRatioBps),
      modifiers: modifierRows.map(toModifier),
      channels,
      inputs: { [IR_KEY]: ir },
      execMode,
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      // Mirror a usage_log row on settle (§C.4) keyed to the resolved model.
      usageLogModel: modelName,
    };
    // Attribute the mirrored usage_log row to the calling api key when present
    // (absent on the dev `x-tenant-id` fallback) — exactOptionalPropertyTypes.
    if (ctx.apiKeyId !== undefined) req.usageLogApiKeyId = ctx.apiKeyId;
    // Per-end-user attribution (端用户数据平面): when the calling key is bound to a
    // subject, thread its id so the engine records `subject_id` on the job/usage_log
    // AND routes the charge to that subject's HARD sub-wallet (else the tenant pool).
    // The `/v1/run` + media-dialect paths set this via `resolveRunRequest`; the chat
    // relay builds its own RunRequest, so it must thread it here too.
    if (ctx.subjectId != null) req.subjectId = ctx.subjectId;
    // Idempotency-Key (P0): thread the caller's key into the engine so a retried
    // relay POST replays the original job instead of re-charging (runChat) — and
    // a reused key on a stream run is rejected (runChatStream).
    if (idempotencyKey !== undefined) req.idempotencyKey = idempotencyKey;
    // 染色: record the canary tag on the engine's relay_trace + usage_log rows.
    if (routeTag !== undefined) req.routeTag = routeTag;
    if (execMode === 'stream') {
      // STREAMING needs a NON-ZERO hold (§C1): `settleStream` caps the final
      // charge at `min(computed, holdAmount)`, so a 0 hold would clamp every
      // streamed settle to 0 (a revenue leak — provider tokens consumed but
      // unbilled). A `post`-timed model_token entry sizes the hold from
      // `estimatedUsage` (priced via the SAME in-process model_token book), so
      // we supply a generous placeholder-ceiling estimate here. The over-hold
      // is fully refunded at settle once the adapter's true usage is observed.
      req.estimatedUsage = estimateStreamUsage(ir);
    } else {
      // BLOCKING settles via `settleSync`, which does NOT cap at the hold, so a
      // 0 floor (settle-time pricing only) is correct and avoids over-holding.
      req.holdFloor = 0n;
    }
    return req;
  }

  /**
   * Build the `model_token` {@link PricebookEntry} for a resolved model: prices
   * the run at `roundHalfUp((in*inputPrice + out*outputPrice) × bps / (1e6 ×
   * 10000))` µUSD — `inputPrice`/`outputPrice` are µUSD per 1M tokens (frozen
   * from the model catalog's resale prices), `bps` is the key's `groupRatioBps`
   * (the per-group customer markup, default 10000 = ×1.0). `post`-timed (settled
   * off the adapter's observed usage); the resource's own DB pricebook is ignored
   * for chat — the model catalog is the source of truth for token pricing. The
   * SAME entry sizes the hold (estimated usage), so the ratio applies uniformly.
   */
  private modelTokenPricebook(
    resolved: ResolvedModel,
    resourceVersion: number,
    groupRatioBps: number,
  ): PricebookEntry {
    return {
      resourceId: resolved.resourceId,
      resourceVersion,
      version: 1,
      method: 'model_token',
      timing: 'post',
      spec: {
        method: 'model_token',
        inputPrice: Number(resolved.inputPrice),
        outputPrice: Number(resolved.outputPrice),
        groupRatioBps,
      },
    };
  }
}

/**
 * Size the streaming hold's upper-bound `estimatedUsage` (snake_case, matching
 * the engine {@link UsageVector}) from the IR (§C1). This is a deliberately
 * GENEROUS PLACEHOLDER CEILING — not a real token count — so the `model_token`
 * hold always exceeds a normal request's true cost and `settleStream`'s cap
 * never clamps the charge; the over-hold is refunded at settle.
 *
 * - `output_tokens`: the request's `params.maxOutputTokens` if set, else the
 *   module ceiling {@link ESTIMATE_OUTPUT_TOKENS_CEILING}.
 * - `input_tokens`: a padded `ceil(JSON.stringify(messages).length / 4)` prompt
 *   estimate (≈4 bytes/token, doubled), so it over-shoots a tight token count.
 */
function estimateStreamUsage(ir: ChatRequest): UsageVector {
  const promptBytes = JSON.stringify(ir.messages).length;
  const inputTokens = Math.ceil(promptBytes / ESTIMATE_BYTES_PER_TOKEN) * ESTIMATE_INPUT_PADDING;
  const outputTokens = ir.params?.maxOutputTokens ?? ESTIMATE_OUTPUT_TOKENS_CEILING;
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

/** Map a `modifier` row to the contracts {@link Modifier} (bigint→number value). */
function toModifier(row: ModifierRow): Modifier {
  const modifier: Modifier = {
    id: row.id,
    scope: row.scope,
    op: row.op as Modifier['op'],
    stackable: row.stackable,
    priority: row.priority,
    version: row.version,
  };
  if (row.whenExpr !== null) modifier.whenExpr = row.whenExpr;
  if (row.value !== null) modifier.value = Number(row.value);
  return modifier;
}
