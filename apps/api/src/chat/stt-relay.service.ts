import type { AdapterRegistry } from '@actionow/adapters';
import type {
  ExecMode,
  IoSchema,
  Modifier,
  PricebookEntry,
  TranscriptionInput,
  UsageVector,
} from '@actionow/contracts';
import {
  type Database,
  getActivePricebookEntry,
  getResource,
  getResourceVersion,
  listApplicableModifiers,
  type ModifierRow,
  type PricebookEntryRow,
} from '@actionow/db';
import type {
  BreakerStore,
  JobQueuePort,
  RunRequest,
  TranscribeRunOutcome,
} from '@actionow/engine';
import { ExecutionService } from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, BREAKER, DB, ENV, JOB_QUEUE } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';

/** The opaque inputs key under which the IR {@link TranscriptionInput} rides into the engine. */
const IR_KEY = '__ir';

/** The seeded STT resource id the `/v1/audio/transcriptions` relay routes onto. */
export const STT_RESOURCE = 'stt-relay';

/**
 * Default CONSERVATIVE bytes-per-second divisor for sizing the audio-duration
 * hold from the upload size. Deliberately LOW (~4000 B/s) so a typical 128 kbps
 * file (≈16 KB/s) OVER-holds rather than under-holds — the settle re-prices on
 * the upstream's ACTUAL duration (capped at the hold). Overridable via
 * `STT_HOLD_BYTES_PER_SECOND`.
 */
const DEFAULT_HOLD_BYTES_PER_SECOND = 4000;

/**
 * Size the upper-bound `estimatedUsage.audio_seconds` from the uploaded file
 * BYTES with a conservative (over-estimating) assumption so the hold is an upper
 * bound the real duration can never exceed:
 *   `estSeconds = max(1, ceil(fileBytes / bytesPerSecond))`.
 * STT can therefore never be made free: the hold balance-gates the run and
 * `settledCost` caps the settle at it (refunding the over-hold).
 */
function estimateAudioSeconds(fileBytes: number, bytesPerSecond: number): UsageVector {
  const estSeconds = Math.max(1, Math.ceil(fileBytes / bytesPerSecond));
  return { audio_seconds: estSeconds };
}

/**
 * The speech-to-text analogue of {@link EmbedRelayService}: funnels `POST
 * /v1/audio/transcriptions` into the engine. Loads the seeded `stt-relay`
 * resource's `unit/post` pricebook (charging the `audio_seconds` dimension),
 * builds a {@link RunRequest} carrying the IR {@link TranscriptionInput} at
 * `inputs.__ir`, sizes a REAL hold from the upload bytes, and drives
 * `runTranscribe` (hold → transcribe → settle-once). Billing is AUDIO-DURATION:
 * the hold is a conservative byte-based over-estimate and the settle re-prices on
 * the upstream's actual reported `duration` (capped at the hold), so STT is
 * always balance-gated and can never settle free.
 */
@Injectable()
export class SttRelayService {
  private readonly http = createHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    @Inject(JOB_QUEUE) private readonly queue: JobQueuePort,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(BREAKER) private readonly breaker: BreakerStore,
    private readonly secrets: SecretResolver,
    private readonly routing: ChannelRoutingService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /** Run a blocking IR speech-to-text request (hold → transcribe → settle-once). */
  async transcribe(
    ir: TranscriptionInput,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<TranscribeRunOutcome> {
    const req = await this.buildTranscribeRunRequest(ir, ctx, idempotencyKey, routeTag);
    return (await this.buildService()).runTranscribe(req);
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
   * Resolve the seeded `stt-relay` resource catalog into a blocking
   * {@link RunRequest} carrying the IR at `inputs.__ir`. Pricing is the
   * resource's OWN active `unit/post` pricebook (charging `audio_seconds`); the
   * hold is sized from the upload bytes (a conservative over-estimate). The
   * request body's `model` rides on the IR and selects the upstream model on the
   * channel; `usageLogModel` is set so the engine mirrors a `usage_log` row.
   */
  private async buildTranscribeRunRequest(
    ir: TranscriptionInput,
    ctx: TenantContext,
    idempotencyKey?: string,
    routeTag?: string,
  ): Promise<RunRequest> {
    const resource = await getResource(this.db, STT_RESOURCE);
    // A GLOBAL platform resource (`tenant_id === null`) is runnable by ANY tenant;
    // a tenant-private one stays isolated to its owner. Missing → 404.
    if (
      resource === undefined ||
      (resource.tenantId !== null && resource.tenantId !== ctx.tenantId)
    ) {
      throw engineNotFound(`speech-to-text resource ${STT_RESOURCE} not found`);
    }
    const version = resource.currentVersion;

    const versionRow = await getResourceVersion(this.db, STT_RESOURCE, version);
    if (versionRow === undefined) {
      throw engineNotFound(
        `speech-to-text resource ${STT_RESOURCE} version ${String(version)} not found`,
      );
    }

    const pricebook = await getActivePricebookEntry(this.db, STT_RESOURCE, version);
    if (pricebook === undefined) {
      throw engineNotFound(`no active pricebook for speech-to-text resource ${STT_RESOURCE}`);
    }

    const channels = await this.routing.candidatesFor(
      STT_RESOURCE,
      ctx.routeGroupId,
      undefined,
      routeTag,
    );
    if (channels.length === 0) {
      throw engineNotFound(
        `no active upstream channel for speech-to-text resource ${STT_RESOURCE}`,
      );
    }

    const modifierRows = await listApplicableModifiers(this.db, {
      tenantId: ctx.tenantId,
      resourceId: STT_RESOURCE,
    });

    // STT_HOLD_BYTES_PER_SECOND is env-only (not in the dynamic SETTINGS_REGISTRY),
    // so read it straight from env with the conservative code default.
    const bytesPerSecond = this.env.STT_HOLD_BYTES_PER_SECOND ?? DEFAULT_HOLD_BYTES_PER_SECOND;

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
      inputs: { [IR_KEY]: ir },
      execMode: 'blocking',
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      usageLogModel: ir.model,
      // The audio file's length is known up front, so size a REAL audio-duration
      // hold from the upload bytes (a conservative over-estimate). `computeHold`
      // floors it at `minimumHold`, so a ~0-balance tenant → `insufficient_credits`
      // (NOT a free transcribe); `settledCost` then caps the settle at the hold.
      estimatedUsage: estimateAudioSeconds(ir.file.length, bytesPerSecond),
    };
    if (ctx.apiKeyId !== undefined) req.usageLogApiKeyId = ctx.apiKeyId;
    if (ctx.subjectId != null) req.subjectId = ctx.subjectId;
    if (idempotencyKey !== undefined) req.idempotencyKey = idempotencyKey;
    if (routeTag !== undefined) req.routeTag = routeTag;
    return req;
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
