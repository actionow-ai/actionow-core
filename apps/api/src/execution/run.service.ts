import type { AdapterRegistry } from '@actionow/adapters';
import type {
  ExecMode,
  IoSchema,
  Modifier,
  PricebookEntry,
  UsageVector,
} from '@actionow/contracts';
import {
  type Database,
  getActivePricebookEntry,
  getResource,
  getResourceVersion,
  listApplicableModifiers,
  listChannels,
  type ModifierRow,
  type PricebookEntryRow,
  type UpstreamChannelRow,
} from '@actionow/db';
import type { JobQueuePort, RunChannel, RunOutcome, RunRequest } from '@actionow/engine';
import { ExecutionService } from '@actionow/engine';
import { FetchHttpClient } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, JOB_QUEUE } from '../common/tokens.js';

/** A `/v1/run` request body (the run inputs + optional async/idempotency knobs). */
export interface RunBody {
  inputs?: Record<string, unknown>;
  exec_mode?: ExecMode;
  callback_url?: string;
  idempotency_key?: string;
  end_user?: string;
  estimated_usage?: UsageVector;
}

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
    private readonly secrets: SecretResolver,
  ) {}

  async run(resourceId: string, body: RunBody, ctx: TenantContext): Promise<RunOutcome> {
    const req = await this.buildRequest(resourceId, body, ctx);
    const service = this.buildService();
    return service.run(req);
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
    });
  }

  /** Resolve the resource catalog into the engine's {@link RunRequest}. */
  private async buildRequest(
    resourceId: string,
    body: RunBody,
    ctx: TenantContext,
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

    const channelRows = await listChannels(this.db, resourceId);
    if (channelRows.length === 0) {
      throw engineNotFound(`no active upstream channel for resource ${resourceId}`);
    }

    const modifierRows = await listApplicableModifiers(this.db, {
      tenantId: ctx.tenantId,
      resourceId,
    });
    const execMode = this.selectExecMode(body.exec_mode, resource.execModes as ExecMode[]);

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
      channels: channelRows.map(toRunChannel),
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
    spec: row.spec as PricebookEntry['spec'],
  };
  if (row.markup !== null) entry.markup = row.markup as PricebookEntry['markup'];
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

/** Map an `upstream_channel` row to the engine's {@link RunChannel}. */
function toRunChannel(row: UpstreamChannelRow): RunChannel {
  return {
    id: row.id,
    weight: row.weight,
    credentialRef: row.credentialRef ?? undefined,
  };
}
