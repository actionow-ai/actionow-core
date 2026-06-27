import type { AdapterRegistry } from '@actionow/adapters';
import type { ExecMode, IoSchema, Modifier, PricebookEntry, RunBody } from '@actionow/contracts';
import { runBodySchema } from '@actionow/contracts';
import {
  type Database,
  findSubjectByExternalId,
  getActivePricebookEntry,
  getResource,
  getResourceVersion,
  listApplicableModifiers,
  type ModifierRow,
  type PricebookEntryRow,
  resolveOrCreateSubject,
} from '@actionow/db';
import type {
  BreakerStore,
  JobQueuePort,
  RunOutcome,
  RunRequest,
  StreamOutcome,
} from '@actionow/engine';
import { ExecutionService } from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { engineInvalidInput, engineNotFound, engineUnauthorized } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, BREAKER, DB, ENV, JOB_QUEUE } from '../common/tokens.js';
import { FilesService } from '../files/files.service.js';
import { SettingsService } from '../settings/settings.service.js';

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
    @Inject(BREAKER) private readonly breaker: BreakerStore,
    private readonly secrets: SecretResolver,
    private readonly routing: ChannelRoutingService,
    private readonly files: FilesService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /**
   * `routeTag` (染色/标签路由) is the `X-Actionow-Route-Tag` canary header — when
   * set it narrows the candidate channels to tag-carrying ones (never widening;
   * zero-match → hard 400) and rides onto the engine's relay_trace + usage_log
   * rows. Header-less (`undefined`) is byte-for-byte unchanged.
   */
  async run(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
    routeTag?: string,
  ): Promise<RunOutcome> {
    const req = await this.buildRequest(resourceId, body, ctx, undefined, routeTag);
    const service = await this.buildService();
    return service.run(req);
  }

  /**
   * Resolve a resource's catalog snapshot into the engine {@link RunRequest},
   * exposed so the OpenAI media-dialect runner can build a request and then drive
   * it to terminal IN-PROCESS (no queue) for a synchronous dialect response.
   *
   * `routeTag` (染色/标签路由) is the `X-Actionow-Route-Tag` canary header — when
   * set it narrows the candidate channels to tag-carrying ones (never widening)
   * and rides onto the engine's relay_trace + usage_log rows.
   */
  resolveRunRequest(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
    forceMode?: ExecMode,
    routeTag?: string,
  ): Promise<RunRequest> {
    return this.buildRequest(resourceId, body, ctx, forceMode, routeTag);
  }

  /**
   * Open a `stream`-mode run. The engine performs the synchronous prefix
   * (validate → quote → hold → job snapshot) and **throws here** on
   * insufficient_credits / invalid_input — so the controller can surface a real
   * HTTP 402/400 via the {@link UnifiedErrorFilter} before any SSE byte is
   * written. The returned `events` is the settling generator the controller
   * pipes to the SSE transport.
   *
   * `routeTag` (染色/标签路由) narrows the candidate channels to tag-carrying ones
   * (never widening; zero-match → hard 400) and rides onto the relay_trace +
   * usage_log rows; header-less (`undefined`) is unchanged.
   */
  async runStream(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
    routeTag?: string,
  ): Promise<StreamOutcome> {
    const req = await this.buildRequest(resourceId, body, ctx, 'stream', routeTag);
    const service = await this.buildService();
    return service.runStream(req);
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
  /**
   * Resolve the subject (end-user) a run attributes to (unified tenancy G-B/G-C):
   * - A subject-scoped key fixes the subject. If `end_user` names a DIFFERENT
   *   subject → 401 (escalation guard: a key bound to one end-user must never act
   *   as another).
   * - A tenant-level key may attribute via `end_user` (the Model-B `external_id`
   *   handle): resolve it, JIT-provisioning when the tenant opted in; an unknown
   *   handle with JIT off → `invalid_input` (never silently skip a paying user).
   * - No subject key and no `end_user` → `null` (tenant-level, today's behavior).
   */
  private async resolveSubject(ctx: TenantContext, body: RunBody): Promise<string | null> {
    const externalId =
      typeof body.end_user === 'string' && body.end_user !== '' ? body.end_user : undefined;

    if (ctx.subjectId != null) {
      if (externalId !== undefined) {
        const named = await findSubjectByExternalId(this.db, ctx.tenantId, externalId);
        if (named !== undefined && named.id !== ctx.subjectId) {
          throw engineUnauthorized('the api key is scoped to a different end-user');
        }
      }
      return ctx.subjectId;
    }

    if (externalId === undefined) return null;
    const subj = await resolveOrCreateSubject(this.db, ctx.tenantId, externalId);
    if (subj === null) {
      throw engineInvalidInput(
        `unknown end_user '${externalId}' (end-user auto-provisioning is disabled for this tenant)`,
      );
    }
    return subj.id;
  }

  private async buildRequest(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
    forceMode?: ExecMode,
    routeTag?: string,
  ): Promise<RunRequest> {
    const resource = await getResource(this.db, resourceId);
    // A GLOBAL platform resource (`tenant_id === null` — the shared media/
    // direct-chat relays) is runnable by ANY tenant; a TENANT-PRIVATE resource
    // (`tenant_id` set) stays isolated to its owner. Missing → 404. The
    // private-resource 404 to a non-owner preserves tenant isolation.
    if (
      resource === undefined ||
      (resource.tenantId !== null && resource.tenantId !== ctx.tenantId)
    ) {
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
    // channels when the group has no members for the resource (compat). 染色: a
    // set `routeTag` (X-Actionow-Route-Tag) narrows these to tag-carrying channels
    // only — never widening; a zero-match throws a hard 400 (no silent leak).
    const channels = await this.routing.candidatesFor(
      resourceId,
      ctx.routeGroupId,
      undefined,
      routeTag,
    );
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
      subjectId: await this.resolveSubject(ctx, body),
      callbackUrl: body.callback_url,
      idempotencyKey: body.idempotency_key,
      endUser: body.end_user,
      estimatedUsage: body.estimated_usage,
    };
    // 染色: record the canary tag on the engine's relay_trace + usage_log rows.
    if (routeTag !== undefined) req.routeTag = routeTag;
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
