// packages/engine/src/planner/gate.ts
//
// model-supply-greenfield 批次3 slice 3b — the §7.8 EXECUTION GATE ORDER
// (hard red line; 交接卡死胡同 #3). The sequence is FIXED and hold placement
// is deliberately LAST among the admission steps:
//
//   1. 租户/key 限流            (checkRateLimit — token buckets only)
//   2. 额度预检                 (precheckQuota — STRICTLY read-only)
//   3. 模型全局闸               (checkModelGate)
//   4. 凭证配额镜像 — 活跃 key 池 (listActiveCredentialsForChannel, per candidate)
//   5. 取 (offering,credential) 信号量 (acquireDualSemaphoreFromPool — §9.1
//      触顶先池内换 key: bounded wait sweeps the WHOLE pool, rng rotation
//      start; only a saturated pool fails over to the next offering)
//   6. hold 预扣                (the FIRST and ONLY ledger write — the request
//                                is now definitely going upstream)
//   7. Reservation              (→ 批次4 dispatches upstream between acquire
//                                and commit; failure calls reservation.release()
//                                = release semaphore + roll back the hold)
//
// WHY hold is NOT first (交接卡死胡同 #3): placing holds before rate limiting
// would write+roll-back the ledger on every request of a 429 storm, shaking
// the books. Steps 1–5 touch NO ledger state, so a rejection at any of them
// leaves zero accounting traces; a failure AFTER step 6 must (and does) roll
// the hold back and free both semaphore dimensions.
//
// Billing (§9.2 叠加顺序): the HOLD is priced from the MODEL's SALE card only
// (模型售价卡 → 倍率组 → 租户折扣 = the sale side; the resolved modifier stack
// is the caller's input). The OFFERING's COST card is fetched alongside and
// snapshot-referenced on the Reservation for the cost side of settle /
// reconciliation (成本卡 ‖ 售价卡, 两侧独立可对账) — it never affects the hold.
//
// Fetch-mode neutrality (§3): the gate assembles the SAME Reservation for all
// four fetch modes; direct's at-most-once crash semantics and the stream
// pre-commit are 批次4's dispatch concerns (planFetch markers ride along).
import type {
  BillingDims,
  GatewayError,
  Modifier,
  PricebookEntry,
  PriceSpec,
  UsageVector,
} from '@actionow/contracts';
import { PRICE_METHODS } from '@actionow/contracts';
import type { DbOrTx, SupplyCredentialRow, SupplyPriceCardRow } from '@actionow/db';
import {
  getSubAccount,
  getSupplyPriceCardsByIds,
  getUsage,
  holdCredits,
  holdSubAccount,
  listActiveCredentialsForChannel,
  releaseHold,
  releaseSubAccountHold,
  windowedUsage,
} from '@actionow/db';
import {
  applyModifiers,
  DomainError,
  type MicroCredits,
  minimumHold,
  quote,
  settle,
} from '@actionow/domain';
import type { ConcurrencyLimiter, RateLimiter } from '@actionow/infra';

import type { AssembledCandidate } from './candidates.js';
import { type FetchPlan, type ParadigmPlan, planFetch } from './fetch-plan.js';
import {
  checkModelGate,
  checkRateLimit,
  type LimitsDeps,
  type ModelLimitResolver,
  precheckQuota,
  type ScopedLimitRule,
} from './limits.js';
import { acquireDualSemaphoreFromPool, type DualSlot } from './semaphore.js';

/** The db reads the gate performs besides the limits queries (injectable). */
export interface GateQueries {
  getUsage: typeof getUsage;
  windowedUsage: typeof windowedUsage;
  listActiveCredentialsForChannel: typeof listActiveCredentialsForChannel;
  getSupplyPriceCardsByIds: typeof getSupplyPriceCardsByIds;
}

/**
 * The ledger surface (REUSED atomic no-oversell primitives — account.ts /
 * sub-account.ts). Injectable so gate tests assert call ORDER and
 * zero-write-on-reject with handwritten fakes.
 */
export interface GateAccounting {
  holdCredits: typeof holdCredits;
  releaseHold: typeof releaseHold;
  getSubAccount: typeof getSubAccount;
  holdSubAccount: typeof holdSubAccount;
  releaseSubAccountHold: typeof releaseSubAccountHold;
}

/** Dependencies for {@link runExecutionGates}. */
export interface GateDeps {
  db: DbOrTx;
  /** Fixed-window per-minute limiter (infra primitive). */
  limiter: RateLimiter;
  /** Concurrency primitive backing the dual semaphore (infra). */
  concurrency: ConcurrencyLimiter;
  /** Injected sleep for the bounded semaphore wait (fake in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Millisecond clock for wait/queue budgets (fake in tests). */
  nowMs: () => number;
  /** Default per-minute caps (dynamic-config resolved by the caller). */
  rateDefaults: { tenantRpm: number; keyRpm: number };
  /** Model global-gate cap resolver (wrap with createCachedModelLimitResolver). */
  resolveModelLimit: ModelLimitResolver;
  waitBaseDelayMs?: number | undefined;
  waitMaxDelayMs?: number | undefined;
  queries?: Partial<GateQueries> | undefined;
  accounting?: Partial<GateAccounting> | undefined;
}

export interface GateInput {
  /** §8-ordered survivors (sortCandidates output) — tried in order. */
  sortedCandidates: AssembledCandidate[];
  tenantId: string;
  /** The tenant pool account the hold lands on (auth-derived). */
  accountId: string;
  /** Subject attribution; a subject with an active sub-wallet holds against it (G-E). */
  subjectId?: string | null | undefined;
  apiKeyId: string | null;
  keyRpm?: number | null | undefined;
  /** The supply model's billing/addressing surface (§2.1). */
  model: {
    id: string;
    name: string;
    /** SALE card (§9.2); null = needs_pricing → un-servable (§10, never 0-priced). */
    priceCardId: string | null;
    modifierGroupId: string | null;
  };
  /** Resolved limit-plan rules (rpm → step 1; spend/tokens/requests → step 2). */
  scopedRules: ScopedLimitRule[];
  /**
   * The RESOLVED sale-side modifier stack (倍率组 → 租户折扣, §9.2).
   * Resolution from model.modifierGroupId is 批次4 wiring; default [].
   */
  modifiers?: Modifier[] | undefined;
  /** Post-timed hold estimation (§9.2 按模型契约估算 — the caller estimates). */
  estimatedUsage?: UsageVector | undefined;
  /** Explicit hold floor override (e.g. 0n = chat's no-reservation discipline). */
  holdFloor?: MicroCredits | undefined;
  /** The §3 external-shape plan — carried onto the Reservation for 批次4. */
  paradigmPlan: ParadigmPlan;
  /** Per-candidate bounded semaphore wait (§7.8 有界等待队列). */
  maxWaitMs: number;
  /** Overall admission budget across all candidates. */
  maxQueueMs: number;
  now: Date;
  /** Uniform RNG in [0,1) — credential rotation + wait jitter (deterministic tests). */
  rng: () => number;
}

/** Where the hold landed — captured at hold time so release hits the SAME wallet. */
export type HoldWallet =
  | { kind: 'tenant'; accountId: string; tenantId: string }
  | { kind: 'subject'; subAccountId: string };

/** The §9.2 price snapshot ref (card id + version — never a live ref). */
export interface PriceCardRef {
  cardId: string;
  version: number;
}

/**
 * The gate's product: everything 批次4 needs to dispatch upstream between
 * semaphore-acquire and commit. `release` is the §7.8 failure path — it frees
 * BOTH semaphore dimensions and rolls back the hold (idempotent).
 */
export interface Reservation {
  candidate: AssembledCandidate;
  credential: SupplyCredentialRow;
  slot: DualSlot;
  fetchPlan: FetchPlan;
  paradigmPlan: ParadigmPlan;
  holdAmount: MicroCredits;
  /** The wallet + amount the hold was written to (what release rolls back). */
  holdTxn: { wallet: HoldWallet; amount: MicroCredits };
  saleCardRef: PriceCardRef;
  /** null = offering has no cost card yet (§2.7 — reconciliation degraded). */
  costCardRef: PriceCardRef | null;
  release: () => Promise<void>;
}

/** One candidate's elimination inside the gate loop (observability trail). */
export interface GateAttempt {
  offeringId: string;
  stage: 'credentials' | 'semaphore' | 'hold';
  reason: string;
}

export interface GateResult {
  reservation?: Reservation | undefined;
  error?: GatewayError | undefined;
  attempts: GateAttempt[];
}

/**
 * §7.8 execution-gate orchestration — see the module header for the fixed
 * order. Red-line invariants (locked by tests):
 *
 * - `holdCredits`/`holdSubAccount` is NEVER invoked before steps 1–5 all pass
 *   for the candidate at hand; a rejection at steps 1–3 performs ZERO ledger
 *   or semaphore operations.
 * - step 2 is read-only (no incr, no ledger, no alerts).
 * - every failure after a partial acquisition rolls back what was taken:
 *   semaphore timeout holds nothing; a failed hold releases the dual slot;
 *   `reservation.release()` frees the slot AND the hold.
 */
export async function runExecutionGates(deps: GateDeps, input: GateInput): Promise<GateResult> {
  const attempts: GateAttempt[] = [];
  if (input.sortedCandidates.length === 0) {
    return {
      error: {
        code: 'internal_error',
        message: 'runExecutionGates called with zero candidates (assembly answers no-supply)',
        retryable: false,
        failover: false,
      },
      attempts,
    };
  }
  const q: GateQueries = {
    getUsage: deps.queries?.getUsage ?? getUsage,
    windowedUsage: deps.queries?.windowedUsage ?? windowedUsage,
    listActiveCredentialsForChannel:
      deps.queries?.listActiveCredentialsForChannel ?? listActiveCredentialsForChannel,
    getSupplyPriceCardsByIds: deps.queries?.getSupplyPriceCardsByIds ?? getSupplyPriceCardsByIds,
  };
  const acct: GateAccounting = {
    holdCredits: deps.accounting?.holdCredits ?? holdCredits,
    releaseHold: deps.accounting?.releaseHold ?? releaseHold,
    getSubAccount: deps.accounting?.getSubAccount ?? getSubAccount,
    holdSubAccount: deps.accounting?.holdSubAccount ?? holdSubAccount,
    releaseSubAccountHold: deps.accounting?.releaseSubAccountHold ?? releaseSubAccountHold,
  };
  const limitsDeps: LimitsDeps = {
    db: deps.db,
    limiter: deps.limiter,
    defaults: deps.rateDefaults,
    queries: { getUsage: q.getUsage, windowedUsage: q.windowedUsage },
  };

  // ── 1. 租户/key 限流 — token buckets only; zero ledger, zero semaphore. ────
  const rate = await checkRateLimit(limitsDeps, {
    tenantId: input.tenantId,
    apiKeyId: input.apiKeyId,
    keyRpm: input.keyRpm,
    modelName: input.model.name,
    scopedRules: input.scopedRules,
  });
  if (!rate.ok) return { error: rate.error, attempts };

  // ── 2. 额度预检 — STRICTLY read-only (§7.8 red line). ─────────────────────
  const quota = await precheckQuota(limitsDeps, {
    scopedRules: input.scopedRules,
    model: input.model.name,
    now: input.now,
  });
  if (!quota.ok) return { error: quota.error, attempts };

  // ── 3. 模型全局闸. ─────────────────────────────────────────────────────────
  const modelGate = await checkModelGate(
    { limiter: deps.limiter, resolveModelLimit: deps.resolveModelLimit },
    { modelName: input.model.name },
  );
  if (!modelGate.ok) return { error: modelGate.error, attempts };

  // Price cards — a READ (sale + every candidate's cost card in one round
  // trip). §10 needs_pricing gate: no sale card ⇒ un-servable, never 0-priced.
  if (input.model.priceCardId === null) {
    return { error: needsPricingError(input.model.name), attempts };
  }
  const cardIds = new Set<string>([input.model.priceCardId]);
  for (const c of input.sortedCandidates) {
    if (c.offering.costPriceCardId !== null) cardIds.add(c.offering.costPriceCardId);
  }
  const cards = await q.getSupplyPriceCardsByIds(deps.db, [...cardIds]);
  const saleCard = cards.get(input.model.priceCardId);
  if (saleCard === undefined) {
    return { error: needsPricingError(input.model.name), attempts };
  }

  // Wallet resolution — a READ, captured ONCE so hold and release hit the
  // SAME wallet even if the sub-wallet's status changes mid-flight (G-E).
  const sub =
    input.subjectId != null
      ? await acct.getSubAccount(deps.db, input.tenantId, input.subjectId)
      : undefined;
  const wallet: HoldWallet =
    sub !== undefined
      ? { kind: 'subject', subAccountId: sub.id }
      : { kind: 'tenant', accountId: input.accountId, tenantId: input.tenantId };

  const startMs = deps.nowMs();
  let sawInsufficientHold = false;

  for (const candidate of input.sortedCandidates) {
    const remaining = input.maxQueueMs - (deps.nowMs() - startMs);
    if (remaining <= 0) break; // overall admission budget spent

    // ── 4. 凭证配额镜像 — the channel's ACTIVE key pool (cooldown-filtered by
    //       the query, §2.4); empty (raced into all-cooled since assembly) ⇒
    //       next candidate; breaker untouched. ──────────────────────────────
    const pool = await q.listActiveCredentialsForChannel(
      deps.db,
      candidate.offering.channelId,
      input.now,
    );
    if (pool.length === 0) {
      attempts.push({
        offeringId: candidate.offering.id,
        stage: 'credentials',
        reason: 'credential pool empty (all cooling) at admission time',
      });
      continue;
    }

    // ── 5. 取 (offering, credential) 双维信号量 — §9.1 触顶先池内换 key: the
    //       bounded wait sweeps the WHOLE pool (rng rotation start, one
    //       immediate attempt per key per round), so a saturated key swaps to
    //       a free sibling instead of eating the budget; only a fully
    //       saturated pool times out ⇒ next candidate (final verdict
    //       rate_limited, §7.8). ──────────────────────────────────────────────
    const rotation = rotatePool(pool, input.rng);
    const slot = await acquireDualSemaphoreFromPool(
      {
        concurrency: deps.concurrency,
        sleep: deps.sleep,
        nowMs: deps.nowMs,
        rng: input.rng,
        waitBaseDelayMs: deps.waitBaseDelayMs,
        waitMaxDelayMs: deps.waitMaxDelayMs,
      },
      {
        offeringId: candidate.offering.id,
        offeringMax: candidate.offering.maxConcurrency,
        credentials: rotation.map((c) => ({
          credentialId: c.id,
          credentialMax: c.quota.max_concurrency,
        })),
        maxWaitMs: Math.min(input.maxWaitMs, remaining),
      },
    );
    if (slot === 'unavailable') {
      // A dimension DECLARED dead (explicit max <= 0 on the offering or every
      // key) — fast failover, no budget burned spinning on absent capacity.
      attempts.push({
        offeringId: candidate.offering.id,
        stage: 'semaphore',
        reason: 'declared zero concurrency capacity (offering or all pool keys max <= 0)',
      });
      continue;
    }
    if (slot === 'timeout') {
      attempts.push({
        offeringId: candidate.offering.id,
        stage: 'semaphore',
        reason: 'bounded semaphore wait timed out (whole key pool saturated)',
      });
      continue;
    }
    // The slot names the pool key it was won on (§9.1 rotation winner).
    const credential = rotation.find((c) => c.id === slot.credentialId);
    if (credential === undefined) {
      // Unreachable (the slot's key always comes from `rotation`) — defensive:
      // never proceed to a ledger write against an unknown credential.
      await releaseSlotBestEffort(slot);
      attempts.push({
        offeringId: candidate.offering.id,
        stage: 'semaphore',
        reason: 'acquired slot references an unknown pool credential',
      });
      continue;
    }

    // ── 6. hold 预扣 — the FIRST ledger write in the entire gate: the
    //       request is now definitely going upstream (§7.8). ────────────────
    let holdAmount: MicroCredits;
    try {
      holdAmount = computeGateHold({
        card: saleCard,
        billingDims: candidate.billingDims,
        estimatedUsage: input.estimatedUsage,
        holdFloor: input.holdFloor,
        modifiers: input.modifiers ?? [],
      });
    } catch (err) {
      // Pricing-config failure is candidate-independent → terminal; the held
      // slot must not leak.
      await releaseSlotBestEffort(slot);
      return { error: holdComputeError(err), attempts };
    }
    let held: boolean;
    try {
      held =
        wallet.kind === 'subject'
          ? await acct.holdSubAccount(deps.db, wallet.subAccountId, holdAmount)
          : await acct.holdCredits(deps.db, wallet.accountId, holdAmount, wallet.tenantId);
    } catch (err) {
      // The hold write REJECTED (db deadlock / outage — not a mere refusal):
      // the dual slot must not leak (§7.8 失败即释放). A ledger failure is
      // candidate-independent → terminal (hammering more holds at a struggling
      // ledger only worsens it); nothing was written (the atomic hold either
      // lands or throws), so the reject path stays zero-ledger-trace.
      await releaseSlotBestEffort(slot);
      attempts.push({
        offeringId: candidate.offering.id,
        stage: 'hold',
        reason: `hold ledger write rejected: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { error: holdWriteError(err), attempts };
    }
    if (!held) {
      // Insufficient balance: free the slot (no half-state) and keep trying —
      // a cheaper candidate's dims could still fit (§7.8: 尝试下一候选或终止).
      await releaseSlotBestEffort(slot);
      sawInsufficientHold = true;
      attempts.push({
        offeringId: candidate.offering.id,
        stage: 'hold',
        reason: `insufficient credits for hold of ${holdAmount.toString()}µ`,
      });
      continue;
    }

    // ── 7. Reservation — 批次4 dispatches upstream between acquire and
    //       commit; on failure it calls release() (§7.8 失败即释放信号量并回滚
    //       hold). release is idempotent. ────────────────────────────────────
    const costCardId = candidate.offering.costPriceCardId;
    const costCard = costCardId !== null ? cards.get(costCardId) : undefined;
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      // The flag is set FIRST intentionally: the hold rollback below is an
      // unconditional ledger decrement, so it must never run twice (a retried
      // release would double-credit `credit_held`). A leaked SLOT, by
      // contrast, self-heals (Redis counter safety TTL) — hence the
      // best-effort slot release must never block the hold rollback.
      released = true;
      await releaseSlotBestEffort(slot);
      if (wallet.kind === 'subject') {
        await acct.releaseSubAccountHold(deps.db, wallet.subAccountId, holdAmount);
      } else {
        await acct.releaseHold(deps.db, wallet.accountId, holdAmount, wallet.tenantId);
      }
    };
    return {
      reservation: {
        candidate,
        credential,
        slot,
        fetchPlan: planFetch(candidate.offering),
        paradigmPlan: input.paradigmPlan,
        holdAmount,
        holdTxn: { wallet, amount: holdAmount },
        saleCardRef: { cardId: saleCard.id, version: saleCard.version },
        costCardRef:
          costCard !== undefined ? { cardId: costCard.id, version: costCard.version } : null,
        release,
      },
      attempts,
    };
  }

  // Every candidate fell (or the queue budget ran out).
  if (sawInsufficientHold) {
    return {
      error: {
        code: 'insufficient_credits',
        message: 'insufficient credits for hold on every routable offering',
        retryable: false,
        failover: false,
      },
      attempts,
    };
  }
  return {
    error: {
      code: 'rate_limited',
      message: 'no (offering, credential) capacity within the admission budget',
      retryable: true,
      failover: false,
    },
    attempts,
  };
}

/**
 * §9.1 rotation: rotate the pool to a random start (same index formula as
 * selectCredential, so single-pick and sweep pick the same first key under the
 * same rng); every key still gets tried, only the starting point spreads load.
 */
function rotatePool(pool: SupplyCredentialRow[], rng: () => number): SupplyCredentialRow[] {
  if (pool.length <= 1) return pool;
  const start = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return start === 0 ? pool : [...pool.slice(start), ...pool.slice(0, start)];
}

/**
 * Best-effort slot release for the gate's failure paths: a semaphore DECR
 * failure must never mask the gate's real verdict or (worse) block a hold
 * rollback — a leaked slot self-heals via the Redis counter's safety TTL.
 */
async function releaseSlotBestEffort(slot: DualSlot): Promise<void> {
  try {
    await slot.release();
  } catch {
    // Swallowed by design (see above).
  }
}

/** Methods whose price is ALWAYS fully known from request params (quote-timed). */
const ALWAYS_PRE_METHODS: ReadonlySet<string> = new Set(['fixed', 'matrix', 'formula']);

/**
 * §9.2/§4 rule 2 — can this card be PRE-quoted from the candidate's canonical
 * billingDims? fixed/matrix/formula always. credits (Vidu/Kling resolution/
 * duration tiers) and model_token are parameter-priced and supported pre by
 * domain quote(): they pre-quote whenever the dims vector carries every priced
 * dimension (§4 rule 2 — 售价按 canonical 生效值计 tier, and billingDims IS
 * the canonical effective vector; upstream translation never affects it).
 * `credits` add-on flags are conditional extras, not baseline dimensions —
 * an absent flag simply isn't charged at hold time (settle recovers it).
 * unit/passthrough are genuinely usage-dependent → never pre.
 */
function preQuotableFromDims(spec: PriceSpec, dims: BillingDims): boolean {
  if (ALWAYS_PRE_METHODS.has(spec.method)) return true;
  if (spec.method === 'credits') {
    return Object.keys(spec.dimensions).every((d) => dims[d] !== undefined);
  }
  if (spec.method === 'model_token') {
    return dims.input_tokens !== undefined && dims.output_tokens !== undefined;
  }
  return false;
}

export interface GateHoldInput {
  /** The model's SALE card (§9.2 — the hold prices the sale side ONLY). */
  card: Pick<SupplyPriceCardRow, 'id' | 'version' | 'spec'>;
  /** §4.1 canonical effective billing values — the tier key / quote params. */
  billingDims: BillingDims;
  /** Caller-estimated usage for post-timed methods (§9.2 按模型契约估算). */
  estimatedUsage?: UsageVector | undefined;
  /** Explicit floor (0n = the no-reservation discipline); absent → minimumHold. */
  holdFloor?: MicroCredits | undefined;
  /** The resolved sale-side modifier stack (倍率组 → 租户折扣). */
  modifiers: Modifier[];
}

/**
 * The modifier-adjusted hold for a supply price card — a PORT of the proven
 * execution-service.ts `computeHold` (quote / settle+minimumHold-floor /
 * holdFloor / applyModifiers), re-based from PricebookEntry onto the §2.7
 * price card. Pure. Timing (§9.2/§4 rule 2): fixed/matrix/formula always
 * pre-quote from the canonical billingDims; credits/model_token pre-quote too
 * whenever the dims carry their priced dimensions (parameter-determined price
 * cards — Vidu/Kling tiers — need NO estimatedUsage); only genuinely
 * usage-dependent pricing (unit/passthrough, or credits/model_token with dims
 * absent) settles an estimate at hold time, floored so a caller-supplied
 * all-zero estimate can never mint a 0 hold (billing-integrity floor).
 */
export function computeGateHold(input: GateHoldInput): MicroCredits {
  const spec = input.card.spec;
  if (!(PRICE_METHODS as readonly string[]).includes(spec.method)) {
    throw new DomainError('invalid_pricing', `unknown price method '${spec.method}'`);
  }
  const preQuote = preQuotableFromDims(spec, input.billingDims);
  // Synthetic PricebookEntry so the REUSED domain primitives (quote / settle /
  // minimumHold — µUSD 七法) price the card without a second implementation.
  const entry: PricebookEntry = {
    resourceId: `price_card:${input.card.id}`,
    resourceVersion: 0,
    version: input.card.version,
    method: spec.method,
    timing: preQuote ? 'pre' : 'post',
    spec,
  };
  let base: MicroCredits;
  if (preQuote) {
    base = quote(entry, input.billingDims);
  } else if (input.estimatedUsage !== undefined) {
    base = settle(entry, input.estimatedUsage);
    // Billing-integrity floor (execution-service computeHold parity): an
    // all-zero caller estimate must not produce a 0 (un-gated) hold.
    const floor = input.holdFloor ?? minimumHold(entry);
    if (floor !== undefined && base < floor) base = floor;
  } else if (input.holdFloor !== undefined) {
    base = input.holdFloor;
  } else {
    throw new DomainError(
      'invalid_pricing',
      'post-timed price card requires estimatedUsage or holdFloor for the hold',
    );
  }
  return applyModifiers(base, input.modifiers).final;
}

/** §10 needs_pricing verdict: a model without a live sale card is un-servable. */
function needsPricingError(modelName: string): GatewayError {
  return {
    code: 'internal_error',
    message: `model '${modelName}' has no live sale price card (needs_pricing) — refusing to serve un-priced`,
    retryable: false,
    failover: false,
  };
}

/** Map a hold-computation throw onto the gateway taxonomy. */
function holdComputeError(err: unknown): GatewayError {
  const message = err instanceof Error ? err.message : 'hold computation failed';
  return {
    code: err instanceof DomainError ? 'invalid_input' : 'internal_error',
    message: `hold computation failed: ${message}`,
    retryable: false,
    failover: false,
  };
}

/**
 * Map a REJECTED hold ledger write (db deadlock / outage) onto the gateway
 * taxonomy: an infra failure, retryable at the request level (deadlocks are
 * transient), zero ledger residue (the atomic hold either lands or throws).
 */
function holdWriteError(err: unknown): GatewayError {
  const message = err instanceof Error ? err.message : 'hold ledger write failed';
  return {
    code: 'internal_error',
    message: `hold ledger write failed: ${message}`,
    retryable: true,
    failover: false,
  };
}
