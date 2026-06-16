import { timingSafeEqual } from 'node:crypto';

import type { AdapterRegistry } from '@actionow/adapters';
import type { Modifier, PricebookEntry } from '@actionow/contracts';
import {
  type Database,
  getAccountByTenant,
  getActivePricebookEntry,
  getJobByUpstreamHandle,
  getResource,
  type Job,
  listApplicableModifiers,
  listChannels,
  type ModifierRow,
  type PricebookEntryRow,
} from '@actionow/db';
import type { JobExecutionContext } from '@actionow/engine';
import { JobRunner, signPayload } from '@actionow/engine';
import { FetchHttpClient } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineUnauthorized } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB } from '../common/tokens.js';

/** The header carrying the upstream HMAC-SHA256 hex signature of the raw body. */
const SIGNATURE_HEADER = 'x-actionow-signature';
/** Optional header carrying a unix-seconds timestamp for replay protection. */
const TIMESTAMP_HEADER = 'x-actionow-timestamp';
/** Replay window: a present timestamp older/newer than this (ms) is rejected. */
const TIMESTAMP_WINDOW_MS = 5 * 60_000;

/**
 * Ingests a signed upstream async-callback. The HMAC over the **raw** request
 * bytes (per the job's channel secret) is the authentication — there is no API
 * key on this route. A verified payload is routed to the engine's dedup-safe
 * `JobRunner.handleCallback`, so a duplicate (or a poll/callback race) converges
 * to exactly one ledger row.
 *
 * No secret material (the channel secret, the signature) is ever logged.
 */
@Injectable()
export class CallbacksService {
  private readonly http = new FetchHttpClient();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    private readonly secrets: SecretResolver,
  ) {}

  /**
   * Verify + ingest a callback. `rawBody` is the exact bytes the signature was
   * computed over; `parsedBody` is the same payload as JSON for correlation.
   * Throws `unauthorized` (→ 401) on a missing/invalid signature, an unknown
   * job, or a stale timestamp. Returns `{ settled }` from the engine.
   */
  async ingest(
    rawBody: Buffer,
    parsedBody: unknown,
    headers: Record<string, string | string[] | undefined>,
    now: Date,
  ): Promise<{ settled: boolean }> {
    // 1. Correlate the payload to a job by its upstream handle (via the adapters'
    //    parseCallback shapes), then load the job.
    const upstreamJobId = this.extractUpstreamJobId(parsedBody);
    if (upstreamJobId === undefined) {
      throw engineUnauthorized('callback does not correlate to a known job');
    }
    const job = await getJobByUpstreamHandle(this.db, upstreamJobId);
    if (job === undefined) {
      throw engineUnauthorized('callback does not correlate to a known job');
    }

    // 2. Resolve the job's channel signing secret and HMAC-verify the raw body.
    const secret = await this.resolveJobSecret(job);
    if (secret === undefined) {
      throw engineUnauthorized('no signing secret for callback');
    }
    if (!this.verifySignature(secret, rawBody, headers, now)) {
      throw engineUnauthorized('invalid callback signature');
    }

    // 3. Route to the dedup-safe engine handler (one ledger row even on replay).
    const runner = this.buildRunner();
    return runner.handleCallback(parsedBody);
  }

  /** Find the upstream job id the way the engine's JobRunner does. */
  private extractUpstreamJobId(payload: unknown): string | undefined {
    for (const providerType of this.adapters.providerTypes()) {
      const adapter = this.adapters.get(providerType);
      if (adapter.parseCallback === undefined) continue;
      try {
        const parsed = adapter.parseCallback(payload);
        if (parsed.upstreamJobId !== '') return parsed.upstreamJobId;
      } catch {
        // Not this adapter's payload shape — try the next.
      }
    }
    return undefined;
  }

  /** Resolve the per-channel signing secret for a job's resource. */
  private async resolveJobSecret(job: Job): Promise<string | undefined> {
    const channels = await listChannels(this.db, job.resourceId);
    for (const channel of channels) {
      if (channel.credentialRef === null) continue;
      const secret = await this.secrets.resolve(channel.credentialRef);
      if (secret !== undefined) return secret;
    }
    return undefined;
  }

  /**
   * Constant-time HMAC verification over the raw body, plus an optional replay
   * window when a timestamp header is present. The recomputed digest and the
   * provided signature are compared with `timingSafeEqual` (length-guarded so a
   * malformed hex never throws).
   */
  private verifySignature(
    secret: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now: Date,
  ): boolean {
    const provided = headerValue(headers, SIGNATURE_HEADER);
    if (provided === undefined) return false;

    const ts = headerValue(headers, TIMESTAMP_HEADER);
    if (ts !== undefined) {
      const tsMs = Number(ts) * 1000;
      if (!Number.isFinite(tsMs) || Math.abs(now.getTime() - tsMs) > TIMESTAMP_WINDOW_MS) {
        return false;
      }
    }

    const expected = signPayload(secret, rawBody.toString('utf8'));
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** A `JobRunner` bound to this app's deps + the callback context loader. */
  private buildRunner(): JobRunner {
    return new JobRunner({
      db: this.db,
      adapters: this.adapters,
      loadContext: (job: Job): Promise<JobExecutionContext> => this.loadContext(job),
      resolveSecret: (ref: string): Promise<string | undefined> => this.secrets.resolve(ref),
      http: this.http,
    });
  }

  /**
   * Build the {@link JobExecutionContext} the engine needs to settle a job from
   * a callback. Mirrors the worker's loader / RunService mapping so a job
   * settles identically whether it was driven by poll or callback.
   */
  private async loadContext(job: Job): Promise<JobExecutionContext> {
    const resource = await getResource(this.db, job.resourceId);
    if (resource === undefined) {
      throw new Error(`loadContext: resource ${job.resourceId} not found`);
    }
    const account = await getAccountByTenant(this.db, job.tenantId);
    if (account === undefined) {
      throw new Error(`loadContext: no account for tenant ${job.tenantId}`);
    }
    const pricebook = await getActivePricebookEntry(this.db, job.resourceId, job.resourceVersion);
    if (pricebook === undefined) {
      throw new Error(`loadContext: no active pricebook for resource ${job.resourceId}`);
    }
    const channelRows = await listChannels(this.db, job.resourceId);
    const modifierRows = await listApplicableModifiers(this.db, {
      tenantId: job.tenantId,
      resourceId: job.resourceId,
    });
    return {
      accountId: account.id,
      providerType: resource.providerType,
      modality: resource.modality,
      pricebookEntry: toPricebookEntry(pricebook),
      modifiers: modifierRows.map(toModifier),
      channels: channelRows.map((c) => ({
        id: c.id,
        weight: c.weight,
        credentialRef: c.credentialRef ?? undefined,
      })),
    };
  }
}

/** Read a single header value (first if an array), case-insensitively by key. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

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
