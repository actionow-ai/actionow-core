import type { AdapterRegistry } from '@actionow/adapters';
import type { ExecMode, IoSchema, Modifier, PricebookEntry } from '@actionow/contracts';
import { EXEC_MODES } from '@actionow/contracts';
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
import { type AppEnv, FetchHttpClient } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { TenantContext } from '../auth/auth.service.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE } from '../common/tokens.js';

/**
 * `/v1/run` request-body schema (the run inputs + optional async/idempotency
 * knobs), enforced at the controller via {@link ZodBody}.
 *
 * `callback_url` is validated as an http(s) URL here (rejecting `file:`,
 * `gopher:`, etc. at ingress); the load-bearing SSRF protection — blocking
 * private/loopback/metadata *addresses* — is the worker's egress guard, since a
 * URL-format check alone accepts `http://169.254.169.254/`. Unknown top-level
 * keys are stripped (not rejected), preserving prior pass-through behavior.
 */
export const RunBodySchema = z.object({
  inputs: z.record(z.unknown()).optional(),
  exec_mode: z.enum(EXEC_MODES).optional(),
  callback_url: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'callback_url must be an http(s) URL',
    })
    .optional(),
  idempotency_key: z.string().min(1).optional(),
  end_user: z.string().optional(),
  estimated_usage: z.record(z.number()).optional(),
});

/** A `/v1/run` request body (the run inputs + optional async/idempotency knobs). */
export type RunBody = z.infer<typeof RunBodySchema>;

/**
 * Loads a resource's frozen catalog snapshot (io_schema, active pricebook,
 * upstream channels, modifiers) from the db and drives one `/v1/run` through
 * the engine's {@link ExecutionService}. This service owns the db→engine
 * mapping; the engine owns the money/orchestration.
 */
@Injectable()
export class RunService {
  private readonly http = new FetchHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    @Inject(JOB_QUEUE) private readonly queue: JobQueuePort,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly secrets: SecretResolver,
    private readonly routing: ChannelRoutingService,
  ) {}

  async run(resourceId: string, body: RunBody, ctx: TenantContext): Promise<RunOutcome> {
    const req = await this.buildRequest(resourceId, body, ctx);
    const service = this.buildService();
    return service.run(req);
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

    const req: RunRequest = {
      resource: {
        id: resource.id,
        version,
        modality: resource.modality,
        ioSchema: versionRow.ioSchema as IoSchema,
        execModes: resource.execModes as ExecMode[],
        providerType: resource.providerType,
      },
      pricebookEntry: toPricebookEntry(pricebook),
      modifiers: modifierRows.map(toModifier),
      channels,
      inputs: body.inputs ?? {},
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
