import type { AdapterRegistry } from '@actionow/adapters';
import type { ExecMode, IoSchema, Modifier, PricebookEntry, RunBody } from '@actionow/contracts';
import { runBodySchema } from '@actionow/contracts';
import {
  type Database,
  getActivePricebookEntry,
  getResource,
  getResourceVersion,
  listApplicableModifiers,
  type ModifierRow,
  type PricebookEntryRow,
} from '@actionow/db';
import type { JobQueuePort, RunOutcome, RunRequest, StreamOutcome } from '@actionow/engine';
import { ExecutionService } from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE } from '../common/tokens.js';
import { FilesService } from '../files/files.service.js';

/**
 * The `/v1/run` request body — the single source of truth lives in
 * @actionow/contracts (`runBodySchema`); re-exported here so the controller's
 * `ZodBody(RunBodySchema)` + `RunBody` type imports are unchanged and the SDK
 * type cannot drift from what the controller validates. (`callback_url` is
 * format-checked at ingress; the load-bearing SSRF protection is the worker's
 * egress guard, which blocks private/loopback/metadata addresses.)
 */
export { runBodySchema as RunBodySchema };
export type { RunBody };

/**
 * Loads a resource's frozen catalog snapshot (io_schema, active pricebook,
 * upstream channels, modifiers) from the db and drives one `/v1/run` through
 * the engine's {@link ExecutionService}. This service owns the db→engine
 * mapping; the engine owns the money/orchestration.
 */
@Injectable()
export class RunService {
  private readonly http = createHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    @Inject(JOB_QUEUE) private readonly queue: JobQueuePort,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly secrets: SecretResolver,
    private readonly routing: ChannelRoutingService,
    private readonly files: FilesService,
  ) {}

  async run(resourceId: string, body: RunBody, ctx: TenantContext): Promise<RunOutcome> {
    const req = await this.buildRequest(resourceId, body, ctx);
    const service = this.buildService();
    return service.run(req);
  }

  /**
   * Resolve a resource's catalog snapshot into the engine {@link RunRequest},
   * exposed so the OpenAI media-dialect runner can build a request and then drive
   * it to terminal IN-PROCESS (no queue) for a synchronous dialect response.
   */
  resolveRunRequest(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
    forceMode?: ExecMode,
  ): Promise<RunRequest> {
    return this.buildRequest(resourceId, body, ctx, forceMode);
  }

  /**
   * Open a `stream`-mode run. The engine performs the synchronous prefix
   * (validate → quote → hold → job snapshot) and **throws here** on
   * insufficient_credits / invalid_input — so the controller can surface a real
   * HTTP 402/400 via the {@link UnifiedErrorFilter} before any SSE byte is
   * written. The returned `events` is the settling generator the controller
   * pipes to the SSE transport.
   */
  async runStream(resourceId: string, body: RunBody, ctx: TenantContext): Promise<StreamOutcome> {
    const req = await this.buildRequest(resourceId, body, ctx, 'stream');
    const service = this.buildService();
    return service.runStream(req);
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
      traceUpstream: this.env.RELAY_TRACE === 'full',
      traceMaxBytes: this.env.RELAY_TRACE_MAX_BYTES,
    });
  }

  /**
   * Resolve the resource catalog into the engine's {@link RunRequest}.
   *
   * `forceMode`, when set, overrides the body's `exec_mode` (still validated
   * against the resource's supported modes) — the SSE endpoint forces `stream`
   * so a client hitting `Accept: text/event-stream` always streams.
   *
   * Channels are the GROUP-SCOPED candidate set (Track 4) built from
   * `ctx.routeGroupId`. This governs the in-process `blocking`/`stream` paths
   * (the engine routes over these channels here). For `async` runs the engine
   * only enqueues the job — the worker re-loads channels from `listChannels`
   * (resource-level, no group) since the job row carries no `route_group_id`
   * (no schema change this track). Wiring the group into the async worker path
   * is deferred to a follow-up (it needs a `job.route_group_id` column).
   */
  private async buildRequest(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
    forceMode?: ExecMode,
  ): Promise<RunRequest> {
    const resource = await getResource(this.db, resourceId);
    if (resource?.tenantId !== ctx.tenantId) {
      throw engineNotFound(`resource ${resourceId} not found`);
    }
    const version = resource.currentVersion;

    const versionRow = await getResourceVersion(this.db, resourceId, version);
    if (versionRow === undefined) {
      throw engineNotFound(`resource ${resourceId} version ${String(version)} not found`);
    }

    const pricebook = await getActivePricebookEntry(this.db, resourceId, version);
    if (pricebook === undefined) {
      throw engineNotFound(`no active pricebook for resource ${resourceId}`);
    }

    // Group-scoped candidate set (Track 4): the key's route group filters the
    // resource's channels (each carrying its per-(group,channel) priority/weight
    // for the engine's priority-tiered fallback), falling back to ALL active
    // channels when the group has no members for the resource (compat).
    const channels = await this.routing.candidatesFor(resourceId, ctx.routeGroupId);
    if (channels.length === 0) {
      throw engineNotFound(`no active upstream channel for resource ${resourceId}`);
    }

    const modifierRows = await listApplicableModifiers(this.db, {
      tenantId: ctx.tenantId,
      resourceId,
    });
    const execMode = this.selectExecMode(
      forceMode ?? body.exec_mode,
      resource.execModes as ExecMode[],
    );

    const ioSchema = versionRow.ioSchema as IoSchema;
    // Resolve any `file`/`file_list` inputs (a file_id → a presigned GET URL) so
    // the adapter receives directly-fetchable URLs — e.g. an img2img reference
    // image for an e-commerce "product photo → variant" run. A no-op (shallow
    // copy) when the resource declares no file inputs.
    const inputs = await this.files.resolveFileInputs(ioSchema, body.inputs ?? {}, ctx);

    const req: RunRequest = {
      resource: {
        id: resource.id,
        version,
        modality: resource.modality,
        ioSchema,
        execModes: resource.execModes as ExecMode[],
        providerType: resource.providerType,
      },
      pricebookEntry: toPricebookEntry(pricebook),
      modifiers: modifierRows.map(toModifier),
      channels,
      inputs,
      execMode,
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      callbackUrl: body.callback_url,
      idempotencyKey: body.idempotency_key,
      endUser: body.end_user,
      estimatedUsage: body.estimated_usage,
    };
    return req;
  }

  /**
   * Pick the run's exec mode: the caller's requested mode (validated against
   * the resource's supported modes) or the resource's first supported mode.
   */
  private selectExecMode(requested: ExecMode | undefined, supported: ExecMode[]): ExecMode {
    if (requested !== undefined) {
      if (!supported.includes(requested)) {
        throw engineInvalidInput(`resource does not support exec_mode "${requested}"`);
      }
      return requested;
    }
    const first = supported[0];
    if (first === undefined) {
      throw engineInvalidInput('resource has no supported exec_mode');
    }
    return first;
  }
}

/** Map a `pricebook_entry` row to the contracts {@link PricebookEntry}. */
function toPricebookEntry(row: PricebookEntryRow): PricebookEntry {
  const entry: PricebookEntry = {
    resourceId: row.resourceId,
    resourceVersion: row.resourceVersion,
    version: row.version,
    method: row.method as PricebookEntry['method'],
    timing: row.timing as PricebookEntry['timing'],
    spec: row.spec,
  };
  if (row.markup !== null) entry.markup = row.markup;
  return entry;
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
