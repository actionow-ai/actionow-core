import type { AdapterRegistry } from '@actionow/adapters';
import type {
  ChatRequest,
  ExecMode,
  IoSchema,
  Modifier,
  PricebookEntry,
} from '@actionow/contracts';
import {
  type Database,
  getResource,
  getResourceVersion,
  listApplicableModifiers,
  listChannels,
  type ModifierRow,
  type UpstreamChannelRow,
} from '@actionow/db';
import type {
  ChatRunOutcome,
  ChatStreamOutcome,
  JobQueuePort,
  RunChannel,
  RunRequest,
} from '@actionow/engine';
import { ExecutionService } from '@actionow/engine';
import { type AppEnv, FetchHttpClient } from '@actionow/infra';
import { normalizeRequest, readCapabilities } from '@actionow/llm-protocol';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE } from '../common/tokens.js';
import { ModelResolverService, type ResolvedModel } from './model-resolver.service.js';

/** The opaque inputs key under which the IR `ChatRequest` rides into the engine. */
const IR_KEY = '__ir';

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
  private readonly http = new FetchHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    @Inject(JOB_QUEUE) private readonly queue: JobQueuePort,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly secrets: SecretResolver,
    private readonly resolver: ModelResolverService,
  ) {}

  /** Open an IR-streaming chat run for the resolved model (hold runs first). */
  async chatStream(
    modelName: string,
    ir: ChatRequest,
    ctx: TenantContext,
  ): Promise<ChatStreamOutcome> {
    const req = await this.buildChatRunRequest(modelName, ir, ctx, 'stream');
    return this.buildService().runChatStream(req);
  }

  /** Run a blocking IR chat for the resolved model (hold → chat → settle-once). */
  async chat(modelName: string, ir: ChatRequest, ctx: TenantContext): Promise<ChatRunOutcome> {
    const req = await this.buildChatRunRequest(modelName, ir, ctx, 'blocking');
    return this.buildService().runChat(req);
  }

  /** Construct an {@link ExecutionService} bound to this app's shared deps. */
  private buildService(): ExecutionService {
    return new ExecutionService({
      db: this.db,
      adapters: this.adapters,
      resolveSecret: (ref: string): Promise<string | undefined> => this.secrets.resolve(ref),
      http: this.http,
      now: () => new Date(),
      enqueue: (jobId: string): Promise<void> => this.queue.enqueueExec(jobId),
      proxyUrlEnv: this.env.UPSTREAM_PROXY_URL,
    });
  }

  /**
   * Resolve the model → chat resource, gate the IR against the model's declared
   * capabilities, and load the resource catalog into a {@link RunRequest} that
   * carries the IR at `inputs.__ir`. Pricing is a `model_token` pricebook built
   * from the resolved model's `inputPrice`/`outputPrice` (NOT the resource's own
   * pricebook), and `usageLogModel` is set so the engine mirrors a `usage_log`
   * row on settle.
   */
  private async buildChatRunRequest(
    modelName: string,
    ir: ChatRequest,
    ctx: TenantContext,
    execMode: ExecMode,
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

    const channelRows = await listChannels(this.db, resourceId);
    if (channelRows.length === 0) {
      throw engineNotFound(`no active upstream channel for chat resource ${resourceId}`);
    }

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
      pricebookEntry: this.modelTokenPricebook(resolved, version),
      modifiers: modifierRows.map(toModifier),
      channels: channelRows.map(toRunChannel),
      inputs: { [IR_KEY]: ir },
      execMode,
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      // Mirror a usage_log row on settle (§C.4) keyed to the resolved model.
      usageLogModel: modelName,
      // A `post`-timed model_token entry prices the hold off observed usage; with
      // no estimate, the engine needs a hold floor. 0 → settle-time pricing only.
      holdFloor: 0n,
    };
    return req;
  }

  /**
   * Build the `model_token` {@link PricebookEntry} for a resolved model: prices
   * the run at `input_tokens*inputPrice + output_tokens*outputPrice` µcredits,
   * frozen from the model catalog's resale prices (`post`-timed; settled off the
   * adapter's observed token usage). The resource's own DB pricebook is ignored
   * for chat — the model catalog is the source of truth for token pricing.
   */
  private modelTokenPricebook(resolved: ResolvedModel, resourceVersion: number): PricebookEntry {
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

/** Map an `upstream_channel` row to the engine's {@link RunChannel}. */
function toRunChannel(row: UpstreamChannelRow): RunChannel {
  return {
    id: row.id,
    weight: row.weight,
    credentialRef: row.credentialRef ?? undefined,
    endpoint: row.endpoint ?? undefined,
    model: row.model ?? undefined,
    proxyRef: row.proxyRef ?? undefined,
    config: row.config ?? undefined,
  };
}
