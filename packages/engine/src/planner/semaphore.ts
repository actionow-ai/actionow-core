// packages/engine/src/planner/semaphore.ts
//
// model-supply-greenfield 批次3 slice 3b — §7.8 (offering, credential) DUAL
// dimension concurrency semaphore with a BOUNDED wait queue.
//
// 合成规则 (§7.8): effective 并发 = min(offering.max_concurrency, credential
// 配额镜像的并发数). Implemented by ACQUIRING BOTH dimensions — holding one
// slot in the offering pool AND one in the credential pool simultaneously is
// exactly the min() semantics, with no min() ever computed: a single-credential
// channel (Dify) with credential max 1 degrades the pool to 1 naturally.
//
// The underlying ConcurrencyLimiter primitive (packages/infra/rate-limit.ts —
// Redis INCR/DECR with safety TTL in production, FakeConcurrencyLimiter in
// tests) is acquire-or-reject with NO waiting; the bounded wait queue (§7.8
// 有界等待队列超时 → failed(rate_limited)) is built HERE on top of it:
// jittered-backoff retries until success or `maxWaitMs` elapses → 'timeout'
// (the ORCHESTRATOR maps that to rate_limited — gate.ts). Sleep and clock are
// injected so tests are deterministic (no real setTimeout waits).
//
// §9.1 池内换 key: {@link acquireDualSemaphoreFromPool} sweeps the WHOLE key
// pool per retry round — one offering-dimension slot per sweep, then ONE
// immediate (no-wait) credential attempt per key in rotation order. A full key
// therefore never eats the budget: the sweep moves straight to a sibling, and
// only a fully-saturated pool backs off / times out (→ offering failover).
//
// max semantics per dimension:
// - null   = the quota declares NO cap (§2.4 mirror members are nullable) →
//   UNBOUNDED on that dimension; the acquire still runs through the semaphore
//   so the in-flight count is kept for observability (仍走信号量记账).
// - <= 0   = an EXPLICIT zero/negative cap → the dimension is UNAVAILABLE:
//   the acquire returns 'unavailable' IMMEDIATELY instead of spinning the
//   whole maxWaitMs on a slot that can never exist (the primitive rejects
//   max <= 0 unconditionally).
//
// Exception safety (§7.8 失败即释放, hard requirement): every partial
// acquisition is rolled back — a REJECTED (thrown, not merely refused)
// credential acquire releases the held offering slot before the error
// surfaces, and a dual-slot release always attempts BOTH dimensions even when
// the first one throws (try/finally; the idempotence flag is set only after
// both succeed, so a failed release may be retried and the underlying
// primitive slots' own idempotence guarantees no double-DECR).
import type { ConcurrencyLimiter, ConcurrencySlot } from '@actionow/infra';

/**
 * The stand-in cap for a null (upstream-undeclared) concurrency dimension:
 * effectively unbounded, but the slot is still counted (observability).
 */
export const UNBOUNDED_CONCURRENCY = Number.MAX_SAFE_INTEGER;

/** The offering-dimension semaphore key. */
export function offeringSemaphoreKey(offeringId: string): string {
  return `sem:offering:${offeringId}`;
}

/** The credential-dimension semaphore key. */
export function credentialSemaphoreKey(credentialId: string): string {
  return `sem:credential:${credentialId}`;
}

/** Dependencies for {@link acquireDualSemaphore} — primitives + injectable time. */
export interface DualSemaphoreDeps {
  /** Production: RedisConcurrencyLimiter; tests: FakeConcurrencyLimiter (infra). */
  concurrency: ConcurrencyLimiter;
  /** Injected sleep — tests pass a fake that advances a fake clock. */
  sleep: (ms: number) => Promise<void>;
  /** Millisecond clock for the wait budget (tests: fake, prod: Date.now). */
  nowMs: () => number;
  /** Uniform RNG in [0,1) for retry jitter; absent → Math.random. */
  rng?: (() => number) | undefined;
  /** First retry delay (ms); doubles per retry. Default 25. */
  waitBaseDelayMs?: number | undefined;
  /** Retry delay ceiling (ms). Default 250. */
  waitMaxDelayMs?: number | undefined;
}

export interface AcquireDualSemaphoreInput {
  offeringId: string;
  /** offering.max_concurrency; null = offering dimension unbounded (§2.5). */
  offeringMax: number | null;
  credentialId: string;
  /** credential quota mirror max_concurrency; null = undeclared → unbounded (§2.4). */
  credentialMax: number | null;
  /** The bounded-queue budget: total time this acquire may wait (§7.8). */
  maxWaitMs: number;
}

/** One key of the §9.1 rotation pool {@link acquireDualSemaphoreFromPool} sweeps. */
export interface PoolCredentialRef {
  credentialId: string;
  /**
   * The key's quota-mirror max_concurrency: null = unbounded; <= 0 = the key
   * is declared unusable and is SKIPPED (never spun on).
   */
  credentialMax: number | null;
}

export interface AcquireDualSemaphoreFromPoolInput {
  offeringId: string;
  /** offering.max_concurrency; null = unbounded; <= 0 = offering unavailable. */
  offeringMax: number | null;
  /**
   * The channel's active key pool in ROTATION ORDER (the caller applies the
   * rng start offset — §9.1 随机轮转起点). Must be non-empty.
   */
  credentials: PoolCredentialRef[];
  /** The bounded-queue budget: total time this acquire may wait (§7.8). */
  maxWaitMs: number;
}

/**
 * One HELD dual slot: both dimensions are occupied until `release`. `release`
 * is idempotent (each underlying primitive slot already is; the wrapper adds
 * its own guard) and frees BOTH dimensions. `credentialId` names the pool key
 * the slot was won on (§9.1 — the gate maps it back to the credential row).
 */
export interface DualSlot {
  offeringId: string;
  credentialId: string;
  release: () => Promise<void>;
}

/**
 * Acquire the §7.8 dual semaphore against a CHANNEL KEY POOL (§9.1 触顶先池内
 * 换 key): per retry round, take one offering-dimension slot, then give every
 * usable key ONE immediate credential-dimension attempt in rotation order —
 * the first free sibling wins. Pool fully saturated → release the offering
 * slot (never park half-held), jittered backoff, retry, until success or
 * `maxWaitMs` elapses → 'timeout' (the gate maps that to offering failover /
 * rate_limited).
 *
 * Returns 'unavailable' — immediately, without burning any wait budget — when
 * the offering cap or EVERY pool key's cap is explicitly <= 0 (a slot can
 * never exist; distinct from null = unbounded). Keys with cap <= 0 inside a
 * mixed pool are simply skipped.
 *
 * Half-hold safety (hard requirement): the offering slot is released before
 * every backoff AND before a rejected (thrown) credential acquire propagates —
 * a waiter never parks holding one dimension, and an infra error never leaks
 * an offering slot.
 */
export async function acquireDualSemaphoreFromPool(
  deps: DualSemaphoreDeps,
  input: AcquireDualSemaphoreFromPoolInput,
): Promise<DualSlot | 'timeout' | 'unavailable'> {
  // Fast-fail on declared-dead dimensions: an explicit 0/negative cap can
  // never yield a slot — spinning maxWaitMs on it would only burn the
  // admission budget (§7.8 有界等待 is for CONTENDED capacity, not absent).
  if (input.offeringMax !== null && input.offeringMax <= 0) return 'unavailable';
  const usable = input.credentials.filter((c) => c.credentialMax === null || c.credentialMax > 0);
  if (usable.length === 0) return 'unavailable';

  const offeringKey = offeringSemaphoreKey(input.offeringId);
  const offeringMax = input.offeringMax ?? UNBOUNDED_CONCURRENCY;
  const rng = deps.rng ?? Math.random;
  const baseDelay = deps.waitBaseDelayMs ?? 25;
  const maxDelay = deps.waitMaxDelayMs ?? 250;

  const start = deps.nowMs();
  let delay = baseDelay;
  // Bounded wait queue: sweep → (release any half-hold) → jittered backoff →
  // re-sweep, until success or the budget is spent.
  for (;;) {
    const offeringSlot = await deps.concurrency.acquire(offeringKey, offeringMax);
    if (offeringSlot.ok) {
      let won: { slot: ConcurrencySlot; credentialId: string } | undefined;
      try {
        // §9.1 in-pool rotation: one immediate attempt per key — a full key
        // costs nothing but the next iteration.
        for (const cred of usable) {
          const slot = await deps.concurrency.acquire(
            credentialSemaphoreKey(cred.credentialId),
            cred.credentialMax ?? UNBOUNDED_CONCURRENCY,
          );
          if (slot.ok) {
            won = { slot, credentialId: cred.credentialId };
            break;
          }
        }
      } catch (err) {
        // A credential acquire REJECTED (infra throw, not a mere refusal):
        // the held offering dimension must not leak past the error.
        await offeringSlot.release();
        throw err;
      }
      if (won !== undefined) {
        return makeDualSlot(input.offeringId, won.credentialId, offeringSlot, won.slot);
      }
      // Whole pool full → release the held offering dimension BEFORE waiting
      // (never park half-held).
      await offeringSlot.release();
    }

    const remaining = input.maxWaitMs - (deps.nowMs() - start);
    if (remaining <= 0) return 'timeout';
    // Jitter in [0.5, 1.0)× so synchronized waiters don't stampede.
    const jittered = Math.max(1, Math.round(delay * (0.5 + rng() * 0.5)));
    await deps.sleep(Math.min(jittered, remaining));
    delay = Math.min(delay * 2, maxDelay);
  }
}

/**
 * Single-credential form of {@link acquireDualSemaphoreFromPool} (a pool of
 * exactly one key) — same bounded wait, same 'unavailable' fast-fail on an
 * explicit <= 0 cap, same exception safety.
 */
export function acquireDualSemaphore(
  deps: DualSemaphoreDeps,
  input: AcquireDualSemaphoreInput,
): Promise<DualSlot | 'timeout' | 'unavailable'> {
  return acquireDualSemaphoreFromPool(deps, {
    offeringId: input.offeringId,
    offeringMax: input.offeringMax,
    credentials: [{ credentialId: input.credentialId, credentialMax: input.credentialMax }],
    maxWaitMs: input.maxWaitMs,
  });
}

/**
 * Bind the two primitive slots into one dual release.
 *
 * Exception safety: try/finally guarantees the offering dimension is released
 * even when the credential release throws (no skipped second dimension). The
 * idempotence flag is set ONLY after both releases succeeded — a throwing
 * release leaves the flag unset so the caller may retry, and retries can never
 * double-DECR because each underlying primitive slot is itself idempotent.
 */
function makeDualSlot(
  offeringId: string,
  credentialId: string,
  offeringSlot: ConcurrencySlot,
  credentialSlot: ConcurrencySlot,
): DualSlot {
  let released = false;
  return {
    offeringId,
    credentialId,
    release: async (): Promise<void> => {
      if (released) return;
      try {
        // Reverse-acquisition order.
        await credentialSlot.release();
      } finally {
        await offeringSlot.release();
      }
      released = true;
    },
  };
}
