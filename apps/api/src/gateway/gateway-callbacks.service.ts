// apps/api/src/gateway/gateway-callbacks.service.ts
//
// model-supply-greenfield 批次4 slice4 — the NEW-WORLD upstream-callback
// ingress (§3 submit_callback fast path; the old /v1/callbacks stays as-is,
// 双面并存). This fixes the legacy envelope 断链: the raw body is NEVER parsed
// before the dialect's aspect-⑥ verifyCallback passes (SPI handleCallback
// enforces the order — 验签过才 parse), and every parse lands in the TYPED
// TaskUpdate IR.
//
// The §3 chain, in order:
//   验签      — the :offeringId route param pins the dialect + channel WITHOUT
//               reading the body; verification runs over the raw bytes against
//               each secret in the channel's credential pool (§2.4 — the
//               submitting key is unknowable and may be cooling) plus the
//               provider callback-verification template (ctx.config).
//   去重      — correlation via getTaskByUpstreamTaskIdForOffering (the handle
//               is only unique per vendor namespace — the VERIFIED offering
//               scopes the lookup so cross-offering handle collisions cannot
//               串扰); an ALREADY-terminal task short-circuits to `stale`
//               RIGHT HERE — 去重先于反查, so a replayed terminal callback
//               never costs an upstream confirm query. Terminal convergence
//               for racing writers is the transitionTask from-guard (a
//               duplicate/late callback folds to `stale`, no double settle,
//               no event).
//   乱序容忍  — non-terminal observations only ever write progress on a LIVE
//               row (they can never fail a task); a mid-state arriving after
//               the terminal write no-ops on the from-guard.
//   反查确认  — a TERMINAL callback is never trusted alone: the task center
//               re-queries the upstream (SPI runTaskQuery) and folds the
//               CONFIRMED update; an unconfirmable terminal is left to the
//               poll backstop (双保险: the callback path never replaces the
//               worker's poll — it only accelerates it).
import type { CredentialSecret, HttpClient, TaskUpdate } from '@actionow/contracts';
import { TERMINAL_TASK_STATUSES } from '@actionow/contracts';
import type { Database, SupplyChannelRow } from '@actionow/db';
import {
  getSupplyChannelById,
  getSupplyOfferingById,
  getSupplyProviderById,
  getTaskByUpstreamTaskIdForOffering,
  listActiveCredentialsForChannel,
  resolveSupplyCredentialSecret,
} from '@actionow/db';
import type { ApplyTaskUpdateOutcome, PersistHook } from '@actionow/engine';
import { applyTaskUpdate, resolveDialectForOffering } from '@actionow/engine';
import type {
  Dialect,
  DialectContext,
  DialectRegistry,
  PipelineDeps,
  RawCallback,
} from '@actionow/spi';
import { handleCallback, runTaskQuery } from '@actionow/spi';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { engineInvalidInput, engineNotFound, engineUnauthorized } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import { GATEWAY_DIALECTS, GATEWAY_HTTP, GATEWAY_PERSIST } from './gateway.tokens.js';

/** Per-probe transport budget for the 反查 confirmation query. */
const CONFIRM_PROBE_TIMEOUT_MS = 30_000;

/** The db reads this service performs, injectable for unit tests. */
export interface GatewayCallbackQueries {
  getSupplyOfferingById: typeof getSupplyOfferingById;
  getSupplyChannelById: typeof getSupplyChannelById;
  getSupplyProviderById: typeof getSupplyProviderById;
  listActiveCredentialsForChannel: typeof listActiveCredentialsForChannel;
  resolveSupplyCredentialSecret: typeof resolveSupplyCredentialSecret;
  getTaskByUpstreamTaskIdForOffering: typeof getTaskByUpstreamTaskIdForOffering;
}

const DEFAULT_QUERIES: GatewayCallbackQueries = {
  getSupplyOfferingById,
  getSupplyChannelById,
  getSupplyProviderById,
  listActiveCredentialsForChannel,
  resolveSupplyCredentialSecret,
  getTaskByUpstreamTaskIdForOffering,
};

/** The ingest verdict answered on the wire (200 unless thrown). */
export interface CallbackIngestResult {
  status: 'accepted';
  /** `true` iff THIS callback's fold performed the terminal write. */
  settled: boolean;
  /** The fold outcome (observability; `unconfirmed` = left to the poll backstop). */
  outcome: ApplyTaskUpdateOutcome['kind'] | 'unconfirmed';
}

const TERMINAL_UPDATE_STATUSES: ReadonlySet<TaskUpdate['status']> = new Set([
  'succeeded',
  'failed',
  'canceled',
  'expired',
]);

@Injectable()
export class GatewayCallbacksService {
  private readonly queries: GatewayCallbackQueries;
  /** The engine's shared TaskUpdate fold (§3 双保险 funnel); injectable for unit tests. */
  private readonly apply: typeof applyTaskUpdate;
  /**
   * §7.5 转存 seam — SYMMETRIC to the poll path's TaskRecoveryDeps.persist:
   * when the callback wins the settle race, the fold must run 转存先于
   * succeeded too (require_persist 失败即 fail 不扣费). `undefined` (today)
   * keeps behavior unchanged; slice5 wires the real hook via GATEWAY_PERSIST
   * and the callback path enforces it automatically.
   */
  private readonly persist: PersistHook | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(GATEWAY_DIALECTS) private readonly registry: DialectRegistry,
    @Inject(GATEWAY_HTTP) private readonly http: HttpClient,
    @Optional() @Inject(GATEWAY_PERSIST) persist?: PersistHook,
  ) {
    this.queries = DEFAULT_QUERIES;
    this.apply = applyTaskUpdate;
    this.persist = persist;
  }

  /**
   * Verify + fold one upstream callback addressed to an offering. Throws
   * `unauthorized` (401) on an unknown offering or a signature no pool secret
   * verifies; `invalid_input` (400) when a VERIFIED body fails to parse;
   * `task_not_found` (404) when the verified update correlates to no live
   * task (the upstream retries — our submit-side handle write may lag).
   */
  async ingest(
    offeringId: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now: Date,
  ): Promise<CallbackIngestResult> {
    // ── 1. offering → dialect + channel context, body UNTOUCHED. ────────────
    const offering = await this.queries.getSupplyOfferingById(this.db, offeringId);
    if (offering === undefined) {
      throw engineUnauthorized('callback does not correlate to a known offering');
    }
    const channel = await this.queries.getSupplyChannelById(this.db, offering.channelId);
    if (channel === undefined) {
      throw engineUnauthorized('callback does not correlate to a known channel');
    }
    const provider = await this.queries.getSupplyProviderById(this.db, channel.providerId);
    const resolved = resolveDialectForOffering(
      { registry: this.registry },
      {
        channel,
        provider:
          provider !== undefined
            ? {
                slug: provider.slug,
                defaultDialect: provider.defaultDialect,
                callbackVerification: provider.callbackVerification,
                region: provider.region,
              }
            : undefined,
        nowMs: now.getTime(),
      },
    );
    if (!resolved.ok) {
      // Config/deploy drift — an operator problem, never the upstream's.
      throw new Error(resolved.error.message);
    }

    // ── 2. 验签 (SPI handleCallback: verify FIRST, parse only if authentic)
    //       against the channel's credential pool + the provider template. ───
    const raw = toRawCallback(rawBody, headers);
    const verdict = await this.verifyAgainstPool(resolved.dialect, resolved.ctx, channel, raw, now);
    if (verdict.kind === 'unauthorized') {
      throw engineUnauthorized('callback signature verification failed');
    }
    if (verdict.kind === 'unparseable') {
      throw engineInvalidInput(`verified callback failed to parse: ${verdict.message}`);
    }
    const update = verdict.update;

    // ── 3. 去重/correlation: the upstream handle finds OUR task WITHIN the
    //       verified offering (handles are per-vendor-namespace — a global
    //       lookup could hit another offering's task on a handle collision
    //       and 误拒 or cross-settle). ─────────────────────────────────────────
    const task = await this.queries.getTaskByUpstreamTaskIdForOffering(
      this.db,
      update.upstreamTaskId,
      offeringId,
    );
    if (task === undefined) {
      throw engineNotFound(`no task correlates to upstream handle ${update.upstreamTaskId}`);
    }
    if (task.offeringId !== offeringId) {
      // Redundant guard (the query above already scopes by offering) — kept
      // as defense in depth against a future query swap.
      throw engineUnauthorized('callback does not correlate to this offering');
    }
    if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status)) {
      // §3 去重先于反查: the correlated task is ALREADY terminal — this is a
      // replayed/late callback. Answer `stale` immediately: no confirmUpstream
      // round-trip (a replay must never cost an upstream runTaskQuery — 放大
      // guard), no fold (the from-guard would no-op it anyway).
      return { status: 'accepted', settled: false, outcome: 'stale' };
    }

    // ── 4. terminal → 反查确认 (query-back, §3): fold the CONFIRMED update;
    //       unconfirmable → the poll backstop converges (双保险). Non-terminal
    //       → fold the observation directly (乱序容忍: never fails a task). ──
    let effective: TaskUpdate = update;
    if (TERMINAL_UPDATE_STATUSES.has(update.status)) {
      const confirmed = await this.confirmUpstream(
        resolved.dialect,
        resolved.ctx,
        verdict.secret ?? verdict.fallbackSecret,
        update,
      );
      if (confirmed === undefined) {
        return { status: 'accepted', settled: false, outcome: 'unconfirmed' };
      }
      effective = confirmed;
    }

    // §7.5 seam: the persist hook rides into the shared fold so a callback-won
    // settle runs 转存先于 succeeded exactly like the poll path.
    const outcome = await this.apply(
      { db: this.db, persist: this.persist },
      task,
      effective,
      'callback',
    );
    return {
      status: 'accepted',
      settled:
        outcome.kind === 'settled' || outcome.kind === 'failed' || outcome.kind === 'canceled',
      outcome: outcome.kind,
    };
  }

  /**
   * Try the channel's credential pool (then the no-secret/template-only leg)
   * until one secret VERIFIES the raw callback. `unauthorized` only when every
   * leg refuses; a verified-then-unparseable body is its own verdict (400 —
   * authenticity established, payload defective).
   */
  private async verifyAgainstPool(
    dialect: Dialect,
    ctx: DialectContext,
    channel: SupplyChannelRow,
    raw: RawCallback,
    now: Date,
  ): Promise<
    | {
        kind: 'verified';
        update: TaskUpdate;
        /** The pool secret that verified; undefined when the template leg did. */
        secret: CredentialSecret | undefined;
        /** First resolvable pool secret — signs the 反查 query when the template leg verified. */
        fallbackSecret: CredentialSecret | undefined;
      }
    | { kind: 'unparseable'; message: string }
    | { kind: 'unauthorized' }
  > {
    const pool = await this.queries.listActiveCredentialsForChannel(this.db, channel.id, now);
    const secrets: (CredentialSecret | undefined)[] = [];
    for (const credential of pool) {
      const secret = await this.queries.resolveSupplyCredentialSecret(this.db, credential.id);
      if (secret !== undefined) secrets.push(secret);
    }
    const fallbackSecret = secrets[0];
    // Template-only verification leg (§2.2 回调验签模板 — secret may be
    // undefined per the aspect-⑥ contract).
    secrets.push(undefined);

    for (const secret of secrets) {
      const result = handleCallback(dialect, raw, secret, ctx);
      if (result.ok) return { kind: 'verified', update: result.update, secret, fallbackSecret };
      if (result.error.code === 'invalid_input') {
        // The SPI's verify-then-parse contract: `invalid_input` means THIS
        // secret VERIFIED the bytes but the payload failed to parse — surface
        // the parse defect, do not keep brute-forcing the pool.
        return { kind: 'unparseable', message: result.error.message };
      }
      // `unauthorized` (this secret refused) or `internal_error` (the
      // verification template THREW for this secret — a broken config, not a
      // verified payload): §2.4 逐个验签 — keep trying the pool. One bad
      // template must never block a sibling key from authenticating a
      // legitimate callback.
    }
    return { kind: 'unauthorized' };
  }

  /**
   * The 反查 leg: re-query the upstream for the task's CURRENT state before
   * trusting a terminal callback. `undefined` = unconfirmable right now (no
   * signing key, query failed, OR the upstream still reports in-flight —
   * eventual consistency); the poll backstop owns convergence (双保险).
   */
  private async confirmUpstream(
    dialect: Dialect,
    ctx: DialectContext,
    secret: CredentialSecret | undefined,
    update: TaskUpdate,
  ): Promise<TaskUpdate | undefined> {
    if (secret === undefined) return undefined;
    const pipeline: PipelineDeps = {
      http: this.http,
      budget: { totalTimeoutMs: CONFIRM_PROBE_TIMEOUT_MS },
    };
    const res = await runTaskQuery(
      dialect,
      { upstreamTaskId: update.upstreamTaskId, secret, ctx },
      pipeline,
    );
    if (!res.ok) return undefined;
    if (!TERMINAL_UPDATE_STATUSES.has(res.update.status)) return undefined;
    return res.update;
  }
}

/** Lower-case, first-value header projection + raw byte text (§6-⑥ RawCallback). */
export function toRawCallback(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): RawCallback {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return { rawBody: rawBody.toString('utf8'), headers: flat };
}
