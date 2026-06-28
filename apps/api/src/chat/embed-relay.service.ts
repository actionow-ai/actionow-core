import type { AdapterRegistry } from '@actionow/adapters';
import type {
  EmbeddingsRequest,
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
import type { BreakerStore, EmbedRunOutcome, JobQueuePort, RunRequest } from '@actionow/engine';
import { EngineError, ExecutionService } from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, BREAKER, DB, ENV, JOB_QUEUE } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModelResolverService, type ResolvedModel } from './model-resolver.service.js';

/** The opaque inputs key under which the IR `EmbeddingsRequest` rides into the engine. */
const IR_KEY = '__ir';

/**
 * Rough bytes-per-token divisor for the input estimate (≈4 bytes/token is the
 * conventional GPT-family heuristic). Only used to size the credit hold.
 */
const ESTIMATE_BYTES_PER_TOKEN = 4;

/**
 * Padding multiplier on the byte estimate so the input-token hold over-shoots a
 * tight `len/4` count (tokenizers vary by dialect/locale).
 */
const ESTIMATE_INPUT_PADDING = 2;

/**
 * Per-input-string token floor for the hold estimate. A short string can still
 * cost several tokens (BPE merges, special tokens, per-call overhead), so the
 * byte-heuristic is floored at this many tokens PER input string — keeping the
 * hold comfortably ABOVE a real provider's `prompt_tokens` so `settledCost`'s
 * cap never clamps a normal request below its true (refund-the-rest) cost.
 */
const ESTIMATE_MIN_TOKENS_PER_INPUT = 8;

/**
 * Size the input-token hold's upper-bound `estimatedUsage` from the IR. Embeddings
 * know their full input at request time, so a GENEROUS over-shoot — the larger of
 * a padded `ceil(bytes / 4)` byte-heuristic and a per-string token floor — is a
 * real, balance-gated reservation. The over-hold is fully refunded at settle once
 * the upstream's true `prompt_tokens` is observed (and `settledCost` caps the
 * charge at the hold). INPUT tokens only — embeddings have no output dimension.
 */
function estimateInputUsage(ir: EmbeddingsRequest): UsageVector {
  const inputs = Array.isArray(ir.input) ? ir.input : [ir.input];
  const bytes = inputs.reduce((sum, s) => sum + s.length, 0);
  const bytePadded = Math.ceil(bytes / ESTIMATE_BYTES_PER_TOKEN) * ESTIMATE_INPUT_PADDING;
  const perStringFloor = Math.max(1, inputs.length) * ESTIMATE_MIN_TOKENS_PER_INPUT;
  return { input_tokens: Math.max(bytePadded, perStringFloor) };
}

/**
 * Unified-error codes that trigger MODEL degradation (模型降级链) — UPSTREAM-side
 * failures where another model may succeed (parity with the chat relay).
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
 * The embeddings analogue of {@link ChatRelayService}: funnels `POST
 * /v1/embeddings` into the engine. Resolves a model name → an embeddings
 * `resourceId` + prices, builds a {@link RunRequest} carrying the IR
 * {@link EmbeddingsRequest} at `inputs.__ir`, and drives `runEmbed` (hold →
 * embed → settle-once). Billing is INPUT-TOKEN-ONLY: the same `model_token`
 * pricebook as chat, but the engine's usage vector carries only `input_tokens`
 * (no `output_tokens`), so `outputPrice` never contributes to the settle.
 */
@Injectable()
export class EmbedRelayService {
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
   * Run a blocking IR embeddings request for the resolved model (hold → embed →
   * settle-once), with MODEL-DEGRADATION fallback (模型降级链): on a RETRYABLE
   * failure (all of a model's channels exhausted), retry with each
   * `fallback_models` name in order. Each attempt is self-contained — `runEmbed`
   * holds, routes, and either settles or RELEASES the hold on failure — so
   * attempts never double-charge. A non-retryable error does NOT fall back. Each
   * attempt uses a distinct idempotency key so a failed claim can't block the
   * next model (mirrors {@link ChatRelayService.chat}).
   */
  async embed(
    modelName: string,
    ir: EmbeddingsRequest,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<EmbedRunOutcome> {
    const chain = [modelName, ...(await getModelFallbacks(this.db, modelName))];
    let lastError: unknown;
    for (const [i, model] of chain.entries()) {
      const isLast = i === chain.length - 1;
      const idem =
        idempotencyKey === undefined || i === 0
          ? idempotencyKey
          : `${idempotencyKey}:fb${String(i)}`;
      try {
        const req = await this.buildEmbedRunRequest(model, ir, ctx, idem, routeTag);
        return await (await this.buildService()).runEmbed(req);
      } catch (err) {
        lastError = err;
        if (isLast || !shouldDegradeToNextModel(err)) throw err;
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
   * Resolve the model → embeddings resource and load the resource catalog into a
   * {@link RunRequest} carrying the IR at `inputs.__ir`. Pricing is a
   * `model_token` pricebook built from the resolved model's prices (the resource's
   * own DB pricebook is ignored, identical to chat), and `usageLogModel` is set so
   * the engine mirrors a `usage_log` row on settle. Blocking-only with a 0
   * `holdFloor` (settle-time pricing only) — mirrors the chat blocking path.
   */
  private async buildEmbedRunRequest(
    modelName: string,
    ir: EmbeddingsRequest,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<RunRequest> {
    const resolved = await this.resolver.resolve(modelName, ctx.tenantId);

    const { resourceId } = resolved;
    const resource = await getResource(this.db, resourceId);
    if (resource === undefined) {
      throw engineNotFound(`embeddings resource ${resourceId} not found`);
    }
    const version = resource.currentVersion;

    const versionRow = await getResourceVersion(this.db, resourceId, version);
    if (versionRow === undefined) {
      throw engineNotFound(`embeddings resource ${resourceId} version ${String(version)} not found`);
    }

    const channels = await this.routing.candidatesFor(
      resourceId,
      ctx.routeGroupId,
      resolved.modelId,
      routeTag,
    );
    if (channels.length === 0) {
      throw engineNotFound(`no active upstream channel for embeddings resource ${resourceId}`);
    }

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
      execMode: 'blocking',
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      usageLogModel: modelName,
      // Embeddings know their full input up front, so size a REAL input-token hold
      // (priced via the SAME in-process model_token book): this both balance-gates
      // the run (a ~0-balance tenant → `insufficient_credits`, NOT a free embed)
      // and caps the settle at the hold via `settledCost`. The over-hold is
      // refunded at settle once the upstream's true `prompt_tokens` is observed.
      estimatedUsage: estimateInputUsage(ir),
    };
    if (ctx.apiKeyId !== undefined) req.usageLogApiKeyId = ctx.apiKeyId;
    if (ctx.subjectId != null) req.subjectId = ctx.subjectId;
    if (idempotencyKey !== undefined) req.idempotencyKey = idempotencyKey;
    if (routeTag !== undefined) req.routeTag = routeTag;
    return req;
  }

  /**
   * Build the `model_token` {@link PricebookEntry} for a resolved model. Embeddings
   * carry no output tokens, so only `inputPrice` ever fires at settle — the same
   * entry shape as chat, charged on INPUT tokens only.
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
