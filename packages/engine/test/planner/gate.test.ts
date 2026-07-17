// §7.8 execution-gate orchestration tests (批次3 slice 3b — 红线核心).
// Every dep is a handwritten recording fake feeding ONE shared event log, so
// the STRICT gate order (rate limit → read-only quota precheck → model gate →
// credential pick → dual semaphore → hold) is asserted as index inequalities,
// and every rejection path is asserted to leave ZERO ledger writes / ZERO
// leaked semaphore slots.
import type { Modifier } from '@actionow/contracts';
import type {
  DbOrTx,
  SupplyCredentialRow,
  SupplyOfferingRow,
  SupplyPriceCardRow,
} from '@actionow/db';
import type { ConcurrencyLimiter, RateLimiter, RateLimitResult } from '@actionow/infra';
import { FakeConcurrencyLimiter } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import {
  computeGateHold,
  credentialSemaphoreKey,
  type GateDeps,
  type GateInput,
  offeringSemaphoreKey,
  runExecutionGates,
} from '../../src/index.js';
import { assembled, credential, NOW, offering, T0 } from './supply-fixtures.js';

/** Any direct db access is a red-line violation — all reads/writes go through fakes. */
const POISONED_DB = new Proxy(
  {},
  {
    get(_t, prop): never {
      throw new Error(`red-line violation: gate touched db.${String(prop)} directly`);
    },
  },
) as unknown as DbOrTx;

function saleCard(over: Partial<SupplyPriceCardRow> = {}): SupplyPriceCardRow {
  return {
    id: 'card-sale',
    name: 'sale',
    method: 'fixed',
    unit: 'request',
    tierDims: [],
    spec: { method: 'fixed', amount: 5000 },
    currency: 'usd',
    version: 3,
    effectiveAt: T0,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...over,
  };
}

interface Harness {
  deps: GateDeps;
  events: string[];
  concurrency: FakeConcurrencyLimiter;
  /** The deterministic clock — advanced only by the injected sleep. */
  clock: () => number;
}

function harness(
  o: {
    rejectRateKeys?: Set<string>;
    usage?: bigint;
    pools?: Record<string, SupplyCredentialRow[]>;
    cards?: SupplyPriceCardRow[];
    holdResult?: boolean;
    /** hold*() REJECTS (db deadlock) instead of resolving (BUG-B regression). */
    holdRejects?: boolean;
    /** Credential-dimension slot releases THROW (BUG-B release-path regression). */
    credentialReleaseThrows?: boolean;
    modelLimit?: number | null;
    subAccountId?: string;
  } = {},
): Harness {
  const events: string[] = [];
  const inner = new FakeConcurrencyLimiter();
  const limiter: RateLimiter = {
    take: (key: string): Promise<RateLimitResult> => {
      events.push(`rate:${key}`);
      if (o.rejectRateKeys?.has(key) === true)
        return Promise.resolve({ allowed: false, retryAfterMs: 999 });
      return Promise.resolve({ allowed: true, retryAfterMs: 0 });
    },
  };
  const concurrency: ConcurrencyLimiter = {
    acquire: async (key, max) => {
      events.push(`sem:${key}`);
      const slot = await inner.acquire(key, max);
      if (o.credentialReleaseThrows === true && slot.ok && key.startsWith('sem:credential:')) {
        return {
          ok: true,
          release: (): Promise<void> => Promise.reject(new Error('redis DECR failed')),
        };
      }
      return slot;
    },
  };
  let t = 0;
  const cardRows = o.cards ?? [saleCard()];
  const deps: GateDeps = {
    db: POISONED_DB,
    limiter,
    concurrency,
    nowMs: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    rateDefaults: { tenantRpm: 600, keyRpm: 120 },
    resolveModelLimit: (name: string) => {
      events.push(`model-gate:${name}`);
      return Promise.resolve(o.modelLimit === undefined ? 50 : o.modelLimit);
    },
    queries: {
      getUsage: () => {
        events.push('quota:getUsage');
        return Promise.resolve(o.usage ?? 0n);
      },
      windowedUsage: () => {
        events.push('quota:windowedUsage');
        return Promise.resolve(o.usage ?? 0n);
      },
      listActiveCredentialsForChannel: (_db: DbOrTx, channelId: string) => {
        events.push(`credentials:${channelId}`);
        return Promise.resolve(
          o.pools?.[channelId] ?? [
            {
              ...credential(`k-${channelId}`, channelId),
              quota: { rpm: null, tpm: null, max_concurrency: 5 },
            },
          ],
        );
      },
      getSupplyPriceCardsByIds: (_db: DbOrTx, ids: string[]) => {
        events.push('price-cards');
        return Promise.resolve(
          new Map(cardRows.filter((c) => ids.includes(c.id)).map((c) => [c.id, c])),
        );
      },
    },
    accounting: {
      holdCredits: (_db: DbOrTx, accountId: string, amount: bigint) => {
        events.push(`hold:${accountId}:${amount.toString()}`);
        if (o.holdRejects === true) return Promise.reject(new Error('deadlock detected'));
        return Promise.resolve(o.holdResult ?? true);
      },
      releaseHold: (_db: DbOrTx, accountId: string, amount: bigint) => {
        events.push(`releaseHold:${accountId}:${amount.toString()}`);
        return Promise.resolve();
      },
      getSubAccount: (() => {
        events.push('wallet:getSubAccount');
        return Promise.resolve(o.subAccountId !== undefined ? { id: o.subAccountId } : undefined);
      }) as never,
      holdSubAccount: (_db: DbOrTx, subId: string, amount: bigint) => {
        events.push(`holdSub:${subId}:${amount.toString()}`);
        if (o.holdRejects === true) return Promise.reject(new Error('deadlock detected'));
        return Promise.resolve(o.holdResult ?? true);
      },
      releaseSubAccountHold: (_db: DbOrTx, subId: string, amount: bigint) => {
        events.push(`releaseSub:${subId}:${amount.toString()}`);
        return Promise.resolve();
      },
    },
  };
  return { deps, events, concurrency: inner, clock: () => t };
}

/** A pool credential row with an explicit quota-mirror max_concurrency. */
function poolKey(
  id: string,
  channelId: string,
  maxConcurrency: number | null,
): SupplyCredentialRow {
  return {
    ...credential(id, channelId),
    quota: { rpm: null, tpm: null, max_concurrency: maxConcurrency },
  };
}

function candidate(id: string, over: Partial<SupplyOfferingRow> = {}) {
  return assembled({ ...offering({ id, channelId: `chan-${id}` }), ...over });
}

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    sortedCandidates: [candidate('off-1')],
    tenantId: 't1',
    accountId: 'acc-1',
    apiKeyId: 'key-1',
    model: { id: 'model-1', name: 'gpt-x', priceCardId: 'card-sale', modifierGroupId: null },
    scopedRules: [
      {
        rule: {
          id: 'rule-spend',
          planId: 'plan-1',
          dimension: 'spend',
          period: 'day',
          cap: 1_000n,
          modelScope: null,
          alertPct: null,
          enforce: 'hard',
          createdAt: T0,
          updatedAt: T0,
        },
        subjectType: 'key',
        subjectId: 'key-1',
      },
    ],
    paradigmPlan: { externalParadigm: 'sync', autoUpgraded: false, reason: 'test plan' },
    maxWaitMs: 100,
    maxQueueMs: 10_000,
    now: NOW,
    rng: () => 0,
    ...over,
  };
}

/** Index of the first event starting with `prefix` (-1 = never happened). */
function at(events: string[], prefix: string): number {
  return events.findIndex((e) => e.startsWith(prefix));
}

describe('runExecutionGates — §7.8 STRICT gate order (hard red line)', () => {
  it('executes rate-limit → quota precheck → model gate → credential pick → semaphore → hold, strictly', async () => {
    const h = harness();
    const result = await runExecutionGates(h.deps, gateInput());
    expect(result.reservation).toBeDefined();
    expect(result.error).toBeUndefined();

    const order = [
      at(h.events, 'rate:rl:tenant:t1'), // 1. 租户/key 限流
      at(h.events, 'quota:getUsage'), // 2. 额度预检 (read-only)
      at(h.events, 'model-gate:gpt-x'), // 3. 模型全局闸
      at(h.events, 'credentials:chan-off-1'), // 4. 凭证配额镜像选 key
      at(h.events, 'sem:sem:offering:off-1'), // 5. (offering,credential) 信号量
      at(h.events, 'hold:acc-1:5000'), // 6. hold 预扣 — LAST
    ];
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThan(order[i - 1] ?? -1);
    }
    // The key bucket rides step 1, the model bucket step 3 — both before any
    // candidate work.
    expect(at(h.events, 'rate:rl:key:t1:key-1')).toBeLessThan(at(h.events, 'quota:getUsage'));
    expect(at(h.events, 'rate:rl:model:gpt-x')).toBeLessThan(at(h.events, 'credentials:'));
  });

  it('rate-limit rejection performs ZERO ledger writes, ZERO semaphore ops, ZERO quota reads', async () => {
    const h = harness({ rejectRateKeys: new Set(['rl:tenant:t1']) });
    const result = await runExecutionGates(h.deps, gateInput());
    expect(result.error?.code).toBe('rate_limited');
    expect(result.error?.retryAfterMs).toBe(999);
    expect(h.events.filter((e) => e.startsWith('hold'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('sem:'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('quota:'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('wallet:'))).toEqual([]);
  });

  it('quota precheck rejection (read-only) stops before the model gate — still zero writes', async () => {
    const h = harness({ usage: 999_999n }); // >= cap 1000
    const result = await runExecutionGates(h.deps, gateInput());
    expect(result.error?.code).toBe('insufficient_credits');
    expect(h.events.filter((e) => e.startsWith('model-gate'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('hold'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('sem:'))).toEqual([]);
  });

  it('model-gate rejection stops before any candidate work', async () => {
    const h = harness({ rejectRateKeys: new Set(['rl:model:gpt-x']) });
    const result = await runExecutionGates(h.deps, gateInput());
    expect(result.error?.code).toBe('rate_limited');
    expect(h.events.filter((e) => e.startsWith('credentials:'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('sem:'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('hold'))).toEqual([]);
  });
});

describe('runExecutionGates — candidate loop (§7.8 steps 4–6)', () => {
  it('semaphore timeout on the first candidate → next candidate; hold only fires for the winner', async () => {
    const h = harness();
    // Pre-fill off-1's offering dimension (max 1) so its semaphore times out.
    const blocker = await h.concurrency.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(blocker.ok).toBe(true);
    const input = gateInput({
      sortedCandidates: [
        candidate('off-1', { maxConcurrency: 1 }),
        candidate('off-2', { maxConcurrency: 1 }),
      ],
      maxWaitMs: 50,
    });
    const result = await runExecutionGates(h.deps, input);
    expect(result.reservation?.candidate.offering.id).toBe('off-2');
    expect(result.attempts).toEqual([
      { offeringId: 'off-1', stage: 'semaphore', reason: expect.stringContaining('timed out') },
    ]);
    const holds = h.events.filter((e) => e.startsWith('hold'));
    expect(holds).toHaveLength(1);
    // The single hold happened only AFTER off-2's semaphore acquire.
    expect(at(h.events, 'hold:')).toBeGreaterThan(at(h.events, 'sem:sem:offering:off-2'));
  });

  it('all candidates timing out → rate_limited with ZERO holds', async () => {
    const h = harness();
    const blocker = await h.concurrency.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(blocker.ok).toBe(true);
    const result = await runExecutionGates(
      h.deps,
      gateInput({ sortedCandidates: [candidate('off-1', { maxConcurrency: 1 })], maxWaitMs: 40 }),
    );
    expect(result.error?.code).toBe('rate_limited');
    expect(h.events.filter((e) => e.startsWith('hold'))).toEqual([]);
  });

  it('an empty credential pool skips the candidate without touching its semaphore', async () => {
    const h = harness({ pools: { 'chan-off-1': [] } });
    const result = await runExecutionGates(
      h.deps,
      gateInput({ sortedCandidates: [candidate('off-1'), candidate('off-2')] }),
    );
    expect(result.reservation?.candidate.offering.id).toBe('off-2');
    expect(h.events.filter((e) => e === 'sem:sem:offering:off-1')).toEqual([]);
    expect(result.attempts[0]?.stage).toBe('credentials');
  });

  it('hold refusal (insufficient balance) releases the dual slot and answers insufficient_credits', async () => {
    const h = harness({ holdResult: false });
    const result = await runExecutionGates(
      h.deps,
      gateInput({ sortedCandidates: [candidate('off-1', { maxConcurrency: 1 })] }),
    );
    expect(result.error?.code).toBe('insufficient_credits');
    expect(result.attempts).toEqual([
      { offeringId: 'off-1', stage: 'hold', reason: expect.stringContaining('insufficient') },
    ]);
    // The slot was released: the offering dimension (max 1) is free again.
    const probe = await h.concurrency.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(probe.ok).toBe(true);
  });
});

describe('runExecutionGates — Reservation contract (§7.8 step 7)', () => {
  it('a successful pass yields the slot + hold + §9.2 dual card refs', async () => {
    const cost: SupplyPriceCardRow = saleCard({ id: 'card-cost', version: 7 });
    const h = harness({ cards: [saleCard(), cost] });
    const result = await runExecutionGates(
      h.deps,
      gateInput({
        sortedCandidates: [candidate('off-1', { costPriceCardId: 'card-cost' })],
      }),
    );
    const r = result.reservation;
    expect(r).toBeDefined();
    if (r === undefined) return;
    expect(r.holdAmount).toBe(5000n);
    expect(r.saleCardRef).toEqual({ cardId: 'card-sale', version: 3 });
    expect(r.costCardRef).toEqual({ cardId: 'card-cost', version: 7 });
    expect(r.credential.id).toBe('k-chan-off-1');
    expect(r.fetchPlan.mode).toBe('direct');
    expect(r.paradigmPlan.externalParadigm).toBe('sync');
    expect(r.holdTxn).toEqual({
      wallet: { kind: 'tenant', accountId: 'acc-1', tenantId: 't1' },
      amount: 5000n,
    });
  });

  it('release() frees the semaphore AND rolls the hold back, idempotently', async () => {
    const h = harness();
    const result = await runExecutionGates(
      h.deps,
      gateInput({ sortedCandidates: [candidate('off-1', { maxConcurrency: 1 })] }),
    );
    const r = result.reservation;
    expect(r).toBeDefined();
    if (r === undefined) return;
    await r.release();
    await r.release(); // second call must be a no-op
    expect(h.events.filter((e) => e.startsWith('releaseHold:acc-1:5000'))).toHaveLength(1);
    // Semaphore capacity (max 1) restored exactly once.
    const probe = await h.concurrency.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(probe.ok).toBe(true);
    const overflow = await h.concurrency.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(overflow.ok).toBe(false);
  });

  it('a subject with an active sub-wallet holds AND releases on the sub-wallet (G-E)', async () => {
    const h = harness({ subAccountId: 'sub-9' });
    const result = await runExecutionGates(h.deps, gateInput({ subjectId: 'subj-1' }));
    const r = result.reservation;
    expect(r).toBeDefined();
    if (r === undefined) return;
    expect(h.events.filter((e) => e.startsWith('holdSub:sub-9:5000'))).toHaveLength(1);
    expect(h.events.filter((e) => e.startsWith('hold:acc-1'))).toEqual([]);
    await r.release();
    expect(h.events.filter((e) => e.startsWith('releaseSub:sub-9:5000'))).toHaveLength(1);
    expect(h.events.filter((e) => e.startsWith('releaseHold:'))).toEqual([]);
  });

  it('a model without a live sale card is un-servable (needs_pricing, §10) — before any candidate work', async () => {
    const h = harness({ cards: [] });
    const result = await runExecutionGates(h.deps, gateInput());
    expect(result.error?.code).toBe('internal_error');
    expect(result.error?.message).toContain('needs_pricing');
    expect(h.events.filter((e) => e.startsWith('sem:'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('hold'))).toEqual([]);
  });
});

describe('runExecutionGates — §9.1 触顶先池内换 key (BUG-A regression)', () => {
  it('a concurrency-saturated key swaps to a free SIBLING in-pool — no timeout, no offering failover', async () => {
    const h = harness({
      pools: {
        'chan-off-1': [poolKey('kA', 'chan-off-1', 1), poolKey('kB', 'chan-off-1', 1)],
      },
    });
    // kA's credential dimension (max 1) is fully held by another request.
    const blocker = await h.concurrency.acquire(credentialSemaphoreKey('kA'), 1);
    expect(blocker.ok).toBe(true);
    // rng=0 → rotation starts at kA, so the saturated key IS tried first.
    const result = await runExecutionGates(h.deps, gateInput());
    expect(result.reservation?.credential.id).toBe('kB');
    expect(result.attempts).toEqual([]); // in-pool swap: no elimination recorded
    expect(h.clock()).toBe(0); // the sibling was tried immediately — zero backoff
    expect(at(h.events, 'sem:sem:credential:kA')).toBeGreaterThanOrEqual(0);
    expect(at(h.events, 'sem:sem:credential:kA')).toBeLessThan(
      at(h.events, 'sem:sem:credential:kB'),
    );
    expect(h.events.filter((e) => e.startsWith('hold'))).toHaveLength(1);
  });

  it('only a FULLY saturated pool fails over to the next offering', async () => {
    const h = harness({
      pools: {
        'chan-off-1': [poolKey('kA', 'chan-off-1', 1), poolKey('kB', 'chan-off-1', 1)],
      },
    });
    const a = await h.concurrency.acquire(credentialSemaphoreKey('kA'), 1);
    const b = await h.concurrency.acquire(credentialSemaphoreKey('kB'), 1);
    expect(a.ok && b.ok).toBe(true);
    const result = await runExecutionGates(
      h.deps,
      gateInput({ sortedCandidates: [candidate('off-1'), candidate('off-2')], maxWaitMs: 50 }),
    );
    expect(result.reservation?.candidate.offering.id).toBe('off-2');
    expect(result.attempts).toEqual([
      { offeringId: 'off-1', stage: 'semaphore', reason: expect.stringContaining('timed out') },
    ]);
    expect(h.events.filter((e) => e.startsWith('hold'))).toHaveLength(1);
  });
});

describe('runExecutionGates — exception safety (BUG-B regression, §7.8 失败即释放)', () => {
  it('a REJECTED hold write (db deadlock) releases the dual slot and answers a retryable internal_error', async () => {
    const h = harness({ holdRejects: true });
    const result = await runExecutionGates(
      h.deps,
      gateInput({
        sortedCandidates: [candidate('off-1', { maxConcurrency: 1 })],
      }),
    );
    expect(result.error?.code).toBe('internal_error');
    expect(result.error?.message).toContain('hold ledger write failed');
    expect(result.error?.retryable).toBe(true);
    expect(result.attempts).toEqual([
      { offeringId: 'off-1', stage: 'hold', reason: expect.stringContaining('rejected') },
    ]);
    // BOTH dimensions were freed: offering (max 1) and the key are acquirable.
    const offeringProbe = await h.concurrency.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(offeringProbe.ok).toBe(true);
    const credProbe = await h.concurrency.acquire(credentialSemaphoreKey('k-chan-off-1'), 1);
    expect(credProbe.ok).toBe(true);
    // And the rejected hold left ZERO ledger residue to roll back.
    expect(h.events.filter((e) => e.startsWith('releaseHold'))).toEqual([]);
  });

  it('reservation.release() still rolls the hold back when the slot release throws (best-effort slot)', async () => {
    const h = harness({ credentialReleaseThrows: true });
    const result = await runExecutionGates(h.deps, gateInput());
    const r = result.reservation;
    expect(r).toBeDefined();
    if (r === undefined) return;
    await r.release(); // must NOT throw despite the credential DECR failure
    expect(h.events.filter((e) => e.startsWith('releaseHold:acc-1:5000'))).toHaveLength(1);
  });
});

describe('runExecutionGates — declared-dead capacity fast-fail (BUG-F regression)', () => {
  it('offering max_concurrency 0 fails over IMMEDIATELY without burning the wait budget', async () => {
    const h = harness();
    const result = await runExecutionGates(
      h.deps,
      gateInput({
        sortedCandidates: [candidate('off-1', { maxConcurrency: 0 }), candidate('off-2')],
        maxWaitMs: 5_000,
      }),
    );
    expect(result.reservation?.candidate.offering.id).toBe('off-2');
    expect(result.attempts).toEqual([
      {
        offeringId: 'off-1',
        stage: 'semaphore',
        reason: expect.stringContaining('zero concurrency capacity'),
      },
    ]);
    expect(h.clock()).toBe(0); // no spin: 'unavailable' is instant
    expect(h.events.filter((e) => e === 'sem:sem:offering:off-1')).toEqual([]);
  });

  it('a max-0 key in the pool is skipped straight to the healthy sibling — never spun on', async () => {
    const h = harness({
      pools: {
        'chan-off-1': [poolKey('dead', 'chan-off-1', 0), poolKey('live', 'chan-off-1', 2)],
      },
    });
    const result = await runExecutionGates(h.deps, gateInput({ maxWaitMs: 5_000 }));
    expect(result.reservation?.credential.id).toBe('live');
    expect(result.attempts).toEqual([]);
    expect(h.clock()).toBe(0);
    expect(h.events.filter((e) => e === 'sem:sem:credential:dead')).toEqual([]);
  });
});

describe('computeGateHold — §9.2 sale-side hold pricing (computeHold port)', () => {
  const modifiers: Modifier[] = [];

  it('a pre-timed (fixed) card quotes directly from billing dims', () => {
    expect(computeGateHold({ card: saleCard(), billingDims: {}, modifiers })).toBe(5000n);
  });

  it('a post-timed (unit) card settles the estimate and floors at one-of-each-dimension', () => {
    const card = saleCard({
      id: 'card-unit',
      method: 'unit',
      spec: { method: 'unit', dimensions: { seconds: { rate: 100 } } },
    });
    expect(
      computeGateHold({
        card,
        billingDims: {},
        estimatedUsage: { seconds: 10 },
        modifiers,
      }),
    ).toBe(1000n);
    // All-zero estimate cannot mint a 0 hold — the minimumHold floor bites.
    expect(computeGateHold({ card, billingDims: {}, estimatedUsage: {}, modifiers })).toBe(100n);
  });

  it('a post-timed card without estimate falls back to the explicit holdFloor, else throws', () => {
    const card = saleCard({
      id: 'card-unit',
      method: 'unit',
      spec: { method: 'unit', dimensions: { seconds: { rate: 100 } } },
    });
    expect(computeGateHold({ card, billingDims: {}, holdFloor: 0n, modifiers })).toBe(0n);
    expect(() => computeGateHold({ card, billingDims: {}, modifiers })).toThrow(
      /estimatedUsage or holdFloor/,
    );
  });

  // ── BUG-D regressions (§9.2/§4 rule 2): parameter-determined credits /
  //    model_token cards pre-quote from billingDims — no estimatedUsage needed.
  const creditsCard = saleCard({
    id: 'card-credits',
    method: 'credits',
    spec: {
      method: 'credits',
      creditValueMicroUsd: 1_000,
      baseCredits: 5,
      dimensions: { duration: { credits: 10 } },
    },
  });

  it('a credits sale card (Vidu/Kling tier) pre-quotes from billingDims alone — the correct tier, not a floor or a throw', () => {
    // duration 8 → credits = 5 + 8×10 = 85 → 85_000µ.
    // BEFORE the fix this threw 'requires estimatedUsage or holdFloor' — a
    // parameter-priced card could not be held without a caller estimate.
    expect(computeGateHold({ card: creditsCard, billingDims: { duration: 8 }, modifiers })).toBe(
      85_000n,
    );
  });

  it('a model_token sale card pre-quotes when the dims carry the token dimensions', () => {
    const card = saleCard({
      id: 'card-mt',
      method: 'model_token',
      spec: { method: 'model_token', inputPrice: 1_000_000, outputPrice: 2_000_000 },
    });
    // (1000×1e6 + 500×2e6) / 1M = 2000µ — priced entirely from the dims.
    expect(
      computeGateHold({
        card,
        billingDims: { input_tokens: 1_000, output_tokens: 500 },
        modifiers,
      }),
    ).toBe(2_000n);
    // Dims WITHOUT the token dimensions stay post-timed: estimate settles.
    expect(
      computeGateHold({
        card,
        billingDims: {},
        estimatedUsage: { input_tokens: 1_000, output_tokens: 500 },
        modifiers,
      }),
    ).toBe(2_000n);
  });

  it('billingDims NOT covering the priced dimensions keeps the post path (estimate + floor / throw)', () => {
    // Estimate path unchanged: {duration: 2} → (5 + 20) × 1000 = 25_000µ.
    expect(
      computeGateHold({
        card: creditsCard,
        billingDims: {},
        estimatedUsage: { duration: 2 },
        modifiers,
      }),
    ).toBe(25_000n);
    // And with neither dims coverage nor estimate nor floor → still refuses.
    expect(() => computeGateHold({ card: creditsCard, billingDims: {}, modifiers })).toThrow(
      /estimatedUsage or holdFloor/,
    );
  });
});
