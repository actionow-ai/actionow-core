// packages/engine/src/planner/breaker-runtime.ts
//
// model-supply-greenfield 批次3 slice 3b — per-OFFERING circuit-breaker
// integration + §2.4 429/401 attribution + in-pool credential rotation.
//
// REUSE, not reinvention: state DECISIONS are the pure FSM transitions in
// packages/engine/src/breaker.ts (onFailureTransition / onSuccessTransition —
// keyed per offering here, §2.5 熔断态 key 在供给项); window sample counting is
// the SAME Redis sliding-window primitive the legacy DefaultBreakerStore uses
// (infra BreakerRedis.recordOutcome — current+previous epoch buckets), keyed
// `offering:<id>`; persistence is the slice-1 repo
// (getSupplyOfferingBreakers / upsertSupplyOfferingBreaker /
// updateSupplyCredential). This module only WIRES them.
//
// §2.4 attribution HARD RED LINE: a 429 counts toward CREDENTIAL cooldown and
// NEVER toward offering breaker samples — the breaker eats ONLY
// 5xx / timeout / protocol errors (key 病与渠道病分开表达). A 401 likewise
// cools the credential without feeding the breaker.
import type { DbOrTx, SupplyCredentialRow } from '@actionow/db';
import {
  getSupplyCredentialById,
  getSupplyOfferingBreakers,
  listActiveCredentialsForChannel,
  updateSupplyCredential,
  upsertSupplyOfferingBreaker,
} from '@actionow/db';
import type { BreakerRedis } from '@actionow/infra';

import {
  type BreakerConfig,
  type BreakerSnapshot,
  onFailureTransition,
  onSuccessTransition,
  openEligibleAt,
} from '../breaker.js';
import { breakerSnapshotFromRow } from './candidates.js';

/**
 * The upstream failure classes the planner attributes (§2.4/§2.5).
 * `rate_limited` (429) and `unauthorized` (401) are CREDENTIAL pathologies →
 * cooldown + in-pool rotation; `5xx` / `timeout` / `protocol` are
 * OFFERING/channel pathologies → breaker samples.
 */
export type UpstreamErrorClass = 'rate_limited' | 'unauthorized' | '5xx' | 'timeout' | 'protocol';

/** The classes that feed the offering breaker (§2.4: 熔断只吃 5xx/超时/协议错). */
export const BREAKER_SAMPLE_CLASSES = ['5xx', 'timeout', 'protocol'] as const;

/** Whether a failure of `errorClass` may enter breaker window samples. */
export function isBreakerSampleClass(errorClass: UpstreamErrorClass): boolean {
  return (BREAKER_SAMPLE_CLASSES as readonly UpstreamErrorClass[]).includes(errorClass);
}

/** The implicit closed snapshot for an offering with no persisted breaker row. */
const CLOSED_SNAPSHOT: BreakerSnapshot = {
  state: 'closed',
  openedAt: null,
  cooldownUntil: null,
  tripCount: 0,
  halfOpenSuccesses: 0,
};

/** The per-offering Redis window key (parallel to the legacy `${channel}:${model}`). */
function offeringBreakerKey(offeringId: string): string {
  return `offering:${offeringId}`;
}

/** The slice-1 persistence surface this runtime consumes (injectable for tests). */
export interface BreakerRuntimeQueries {
  getSupplyOfferingBreakers: typeof getSupplyOfferingBreakers;
  upsertSupplyOfferingBreaker: typeof upsertSupplyOfferingBreaker;
  updateSupplyCredential: typeof updateSupplyCredential;
  getSupplyCredentialById: typeof getSupplyCredentialById;
  listActiveCredentialsForChannel: typeof listActiveCredentialsForChannel;
}

/** Dependencies for {@link recordOfferingOutcome} (window store + FSM persistence). */
export interface OfferingOutcomeDeps {
  db: DbOrTx;
  /** The REUSED sliding-window primitive (infra breaker-redis). */
  redis: BreakerRedis;
  queries?: Partial<BreakerRuntimeQueries> | undefined;
}

/** Dependencies for the credential-side runtime (cooldown writes / pool reads). */
export interface CredentialRuntimeDeps {
  db: DbOrTx;
  queries?: Partial<BreakerRuntimeQueries> | undefined;
}

export interface RecordOfferingOutcomeInput {
  offeringId: string;
  outcome: 'success' | 'failure';
  /**
   * Required attribution for failures (§2.4). Absent on a failure → treated
   * as `protocol` (an unclassified hard failure is a channel pathology, and
   * defaulting INTO the breaker is the safe direction — it only optimizes
   * routing). Ignored for successes.
   */
  errorClass?: UpstreamErrorClass | undefined;
  /** Effective breaker thresholds (§2.5 — resolveBreakerConfig upstream). */
  cfg: BreakerConfig;
  now: Date;
}

/**
 * Record one upstream outcome against the offering's breaker (§2.5):
 *
 * - success → window success sample + pure-FSM `onSuccessTransition`
 *   (half_open advances; reaching the threshold closes → persisted + window
 *   cleared so a stale burst can't instantly re-trip — DefaultBreakerStore
 *   parity).
 * - failure attributed 5xx/timeout/protocol → window failure sample +
 *   `onFailureTransition` (may trip open → persisted).
 * - failure attributed 429/401 → NOTHING here: zero window samples, zero FSM
 *   feeding, zero persistence (§2.4 red line). The credential cooldown is the
 *   ORCHESTRATOR's separate {@link recordCredentialCooldown} call.
 *
 * §2.5 lifecycle — half-open probe outcomes: candidates.ts admits an OPEN
 * offering whose cooldown has elapsed as the half-open probe (the legacy
 * filterAvailable pattern), but the persisted row still says 'open' and the
 * pure FSM has NO open→x transitions. So an outcome recorded against an
 * open+cooldown-elapsed snapshot is fed to the FSM AS HALF-OPEN (successes
 * reset — probing starts fresh): a probe success advances toward closed
 * (threshold → closed, consecutive_opens → 0); a probe failure re-opens with
 * consecutive_opens+1, growing the cooldown exponentially (5s → … → 300s cap
 * via cooldownMs). Without this the breaker locked open forever: past the
 * first cooldown it admitted every request while the state never advanced —
 * a sick offering kept full traffic, backoff never grew. The row stays 'open'
 * until the first probe outcome lands, and concurrent probes are NOT
 * trial-count-gated (an optional hardening, deliberately omitted — the
 * lifecycle ADVANCING is the invariant; the FSM itself is still breaker.ts).
 *
 * Best-effort like the legacy store: the breaker only OPTIMIZES routing, so
 * any Redis/PG error here is swallowed — an outcome write must never fail the
 * request path.
 */
export async function recordOfferingOutcome(
  deps: OfferingOutcomeDeps,
  input: RecordOfferingOutcomeInput,
): Promise<void> {
  const q = runtimeQueries(deps.queries);
  try {
    if (input.outcome === 'failure') {
      const errorClass = input.errorClass ?? 'protocol';
      // §2.4 attribution split: credential pathologies never reach the breaker.
      if (!isBreakerSampleClass(errorClass)) return;
      const win = await deps.redis.recordOutcome(
        offeringBreakerKey(input.offeringId),
        input.cfg.windowMs,
        true,
        input.now.getTime(),
      );
      const cur = probeView(await loadSnapshot(deps.db, q, input.offeringId, input.cfg), input.now);
      const next = onFailureTransition(cur, input.cfg, win, input.now);
      if (next !== null) await persistSnapshot(deps.db, q, input.offeringId, next);
      return;
    }

    // success
    await deps.redis.recordOutcome(
      offeringBreakerKey(input.offeringId),
      input.cfg.windowMs,
      false,
      input.now.getTime(),
    );
    const cur = probeView(await loadSnapshot(deps.db, q, input.offeringId, input.cfg), input.now);
    const next = onSuccessTransition(cur, input.cfg);
    if (next !== null) {
      await persistSnapshot(deps.db, q, input.offeringId, next);
      if (next.state === 'closed') {
        // Closing clears the window (legacy onSuccess parity).
        await deps.redis.clearWindow(
          offeringBreakerKey(input.offeringId),
          input.cfg.windowMs,
          input.now.getTime(),
        );
      }
    }
  } catch {
    // Best-effort: a breaker bookkeeping outage must never fail the request.
  }
}

export interface RecordCredentialCooldownInput {
  credentialId: string;
  now: Date;
  /** How long the key sits out of the pool (upstream Retry-After or policy default). */
  cooldownMs: number;
  /** §2.4 attribution: both 429 and 401 cool the credential (never the breaker). */
  reason: '429' | '401';
}

/**
 * §2.4 — stamp `cooldown_until = max(existing, now + cooldownMs)` on the
 * credential. The max keeps a LONG cooldown (401 revocation-suspect) from
 * being TRUNCATED by a concurrent short one (429 backoff) landing later —
 * read-compare-write: when the stored cooldown already reaches further, the
 * write is skipped entirely. (The remaining read→write race can only ever
 * fail to EXTEND, never shorten a cooldown that was visible at read time.)
 * The pool query (listActiveCredentialsForChannel) already excludes cooling
 * keys, so the very next pool sweep rotates onto a sibling key; an all-cooled
 * pool marks the OFFERING 暂不可用 (candidates.ts filter) without opening the
 * breaker. `reason` is attribution metadata for the caller's trace — both
 * classes write the same cooldown.
 */
export async function recordCredentialCooldown(
  deps: CredentialRuntimeDeps,
  input: RecordCredentialCooldownInput,
): Promise<void> {
  const q = runtimeQueries(deps.queries);
  const target = new Date(input.now.getTime() + input.cooldownMs);
  const row = await q.getSupplyCredentialById(deps.db, input.credentialId);
  if (row?.cooldownUntil != null && row.cooldownUntil.getTime() >= target.getTime()) return;
  await q.updateSupplyCredential(deps.db, input.credentialId, { cooldownUntil: target });
}

export interface SelectCredentialInput {
  channelId: string;
  now: Date;
  /** Uniform RNG in [0,1) — injected for deterministic rotation in tests. */
  rng: () => number;
}

/**
 * Pick ONE usable key from the channel's active pool (随机轮转 across the
 * non-cooling keys; the pool query is the cooldown filter, so §2.5's rule that
 * half-open probe requests take the NORMAL pool path — never bypassing
 * cooldown — holds by construction). `undefined` = pool empty (all cooling /
 * none active). NOTE: the §7.8 gate no longer single-picks — it fetches the
 * pool once and SWEEPS it inside the dual-semaphore wait (§9.1 触顶先池内换
 * key, same rng rotation-start formula); this helper remains for single-pick
 * call sites (e.g. probe/dispatch paths that need one key without a slot).
 */
export async function selectCredential(
  deps: CredentialRuntimeDeps,
  input: SelectCredentialInput,
): Promise<SupplyCredentialRow | undefined> {
  const q = runtimeQueries(deps.queries);
  const pool = await q.listActiveCredentialsForChannel(deps.db, input.channelId, input.now);
  if (pool.length === 0) return undefined;
  const index = Math.min(pool.length - 1, Math.floor(input.rng() * pool.length));
  return pool[index];
}

/** Resolve the injectable queries over the real slice-1 repo functions. */
function runtimeQueries(overrides: Partial<BreakerRuntimeQueries> | undefined) {
  return {
    getSupplyOfferingBreakers: overrides?.getSupplyOfferingBreakers ?? getSupplyOfferingBreakers,
    upsertSupplyOfferingBreaker:
      overrides?.upsertSupplyOfferingBreaker ?? upsertSupplyOfferingBreaker,
    updateSupplyCredential: overrides?.updateSupplyCredential ?? updateSupplyCredential,
    getSupplyCredentialById: overrides?.getSupplyCredentialById ?? getSupplyCredentialById,
    listActiveCredentialsForChannel:
      overrides?.listActiveCredentialsForChannel ?? listActiveCredentialsForChannel,
  } satisfies BreakerRuntimeQueries;
}

/**
 * The FSM view of a snapshot for outcome recording (§2.5): an OPEN breaker
 * whose cooldown has elapsed is live-probing (candidates.ts already routes it),
 * so its outcomes carry HALF-OPEN semantics — successes reset to 0 because the
 * probe episode starts fresh (legacy filterAvailable promotion parity). Any
 * other state passes through untouched (an in-flight straggler finishing
 * while the breaker still cools moves nothing).
 */
function probeView(cur: BreakerSnapshot, now: Date): BreakerSnapshot {
  if (cur.state === 'open' && openEligibleAt(cur, now)) {
    return { ...cur, state: 'half_open', halfOpenSuccesses: 0 };
  }
  return cur;
}

/** Load the offering's current FSM snapshot (missing row = closed initial state). */
async function loadSnapshot(
  db: DbOrTx,
  q: BreakerRuntimeQueries,
  offeringId: string,
  cfg: BreakerConfig,
): Promise<BreakerSnapshot> {
  const rows = await q.getSupplyOfferingBreakers(db, [offeringId]);
  const row = rows.get(offeringId);
  return row === undefined ? CLOSED_SNAPSHOT : breakerSnapshotFromRow(row, cfg);
}

/** Land a pure-FSM next-state into the slice-1 breaker row (tripCount = consecutive_opens). */
async function persistSnapshot(
  db: DbOrTx,
  q: BreakerRuntimeQueries,
  offeringId: string,
  next: BreakerSnapshot,
): Promise<void> {
  await q.upsertSupplyOfferingBreaker(db, offeringId, {
    state: next.state,
    openedAt: next.openedAt,
    halfOpenSuccesses: next.halfOpenSuccesses,
    consecutiveOpens: next.tripCount,
  });
}
