import type { AdapterRegistry } from '@actionow/adapters';
import type {
  ExecMode,
  IoSchema,
  ModerationRequest,
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
import type { BreakerStore, JobQueuePort, ModerateRunOutcome, RunRequest } from '@actionow/engine';
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

/** The opaque inputs key under which the IR `ModerationRequest` rides into the engine. */
const IR_KEY = '__ir';

/** Rough bytes-per-token divisor for the input estimate (≈4 bytes/token). */
const ESTIMATE_BYTES_PER_TOKEN = 4;

/** Padding multiplier on the byte estimate so the input-token hold over-shoots. */
const ESTIMATE_INPUT_PADDING = 2;

/**
 * Per-input-string token floor for the hold estimate. Keeps the hold comfortably
 * ABOVE a real provider's input-token count so `settledCost`'s cap never clamps a
 * normal request below its true (refund-the-rest) cost.
 */
const ESTIMATE_MIN_TOKENS_PER_INPUT = 8;

/**
 * Size the input-token hold's upper-bound `estimatedUsage` from the IR. Moderation
 * knows its full input at request time, so a GENEROUS over-shoot — the larger of a
 * padded `ceil(bytes / 4)` byte-heuristic and a per-string token floor — is a real,
 * balance-gated reservation. INPUT tokens only — moderation has no output dimension.
 */
function estimateInputUsage(ir: ModerationRequest): UsageVector {
  const inputs = Array.isArray(ir.input) ? ir.input : [ir.input];
  const bytes = inputs.reduce((sum, s) => sum + s.length, 0);
  const bytePadded = Math.ceil(bytes / ESTIMATE_BYTES_PER_TOKEN) * ESTIMATE_INPUT_PADDING;
  const perStringFloor = Math.max(1, inputs.length) * ESTIMATE_MIN_TOKENS_PER_INPUT;
  return { input_tokens: Math.max(bytePadded, perStringFloor) };
}

/** Unified-error codes that trigger MODEL degradation (模型降级链) — parity with chat/embeddings. */
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
 * The moderation analogue of {@link EmbedRelayService}: funnels `POST
 * /v1/moderations` into the engine. Resolves a model name → a moderation
 * `resourceId` + prices, builds a {@link RunRequest} carrying the IR
 * {@link ModerationRequest} at `inputs.__ir`, and drives `runModerate` (hold →
 * moderate → settle-once). Billing is INPUT-TOKEN-ONLY: the same `model_token`
 * pricebook as chat, but the usage vector carries only `input_tokens`, so
 * `outputPrice` never contributes. Feeds the compliance moat.
 */
@Injectable()
export class ModerationRelayService {
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
   * Run a blocking IR moderation for the resolved model (hold → moderate →
   * settle-once), with MODEL-DEGRADATION fallback (模型降级链): on a RETRYABLE
   * failure, retry with each `fallback_models` name in order. Each attempt uses a
   * distinct idempotency key (mirrors {@link EmbedRelayService}).
   */
  async moderate(
    modelName: string,
    ir: ModerationRequest,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<ModerateRunOutcome> {
    const chain = [modelName, ...(await getModelFallbacks(this.db, modelName))];
    let lastError: unknown;
    for (const [i, model] of chain.entries()) {
      const isLast = i === chain.length - 1;
      const idem =
        idempotencyKey === undefined || i === 0
          ? idempotencyKey
          : `${idempotencyKey}:fb${String(i)}`;
      try {
        const req = await this.buildModerateRunRequest(model, ir, ctx, idem, routeTag);
        return await (await this.buildService()).runModerate(req);
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
   * Resolve the model → moderation resource and load the resource catalog into a
   * {@link RunRequest} carrying the IR at `inputs.__ir`. Pricing is a `model_token`
   * pricebook built from the resolved model's prices, and `usageLogModel` is set so
   * the engine mirrors a `usage_log` row on settle.
   */
  private async buildModerateRunRequest(
    modelName: string,
    ir: ModerationRequest,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<RunRequest> {
    const resolved = await this.resolver.resolve(modelName, ctx.tenantId);

    const { resourceId } = resolved;
    const resource = await getResource(this.db, resourceId);
    if (resource === undefined) {
      throw engineNotFound(`moderation resource ${resourceId} not found`);
    }
    const version = resource.currentVersion;

    const versionRow = await getResourceVersion(this.db, resourceId, version);
    if (versionRow === undefined) {
      throw engineNotFound(
        `moderation resource ${resourceId} version ${String(version)} not found`,
      );
    }

    const channels = await this.routing.candidatesFor(
      resourceId,
      ctx.routeGroupId,
      resolved.modelId,
      routeTag,
    );
    if (channels.length === 0) {
      throw engineNotFound(`no active upstream channel for moderation resource ${resourceId}`);
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
      // Moderation knows its full input up front, so size a REAL input-token hold
      // (priced via the SAME in-process model_token book): balance-gates the run
      // AND caps the settle at the hold via `settledCost`. The over-hold is
      // refunded at settle once the true input-token count is observed.
      estimatedUsage: estimateInputUsage(ir),
    };
    if (ctx.apiKeyId !== undefined) req.usageLogApiKeyId = ctx.apiKeyId;
    if (ctx.subjectId != null) req.subjectId = ctx.subjectId;
    if (idempotencyKey !== undefined) req.idempotencyKey = idempotencyKey;
    if (routeTag !== undefined) req.routeTag = routeTag;
    return req;
  }

  /**
   * Build the `model_token` {@link PricebookEntry} for a resolved model. Moderation
   * carries no output tokens, so only `inputPrice` ever fires at settle.
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
