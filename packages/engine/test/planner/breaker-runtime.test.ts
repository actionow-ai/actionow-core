// Per-offering breaker runtime unit tests (批次3 slice 3b). Locks the §2.4
// attribution red line: 429/401 cool the CREDENTIAL and contribute ZERO
// breaker samples — the breaker eats only 5xx/timeout/protocol.
import type {
  DbOrTx,
  SupplyCredentialRow,
  SupplyOfferingBreakerRow,
  SupplyOfferingBreakerSnapshotInput,
  UpdateSupplyCredentialInput,
} from '@actionow/db';
import type { BreakerRedis, BreakerWindow } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import {
  cooldownMs,
  DEFAULT_BREAKER_CONFIG,
  recordCredentialCooldown,
  recordOfferingOutcome,
  selectCredential,
} from '../../src/index.js';
import { breakerRow, credential, NOW } from './supply-fixtures.js';

const DB = {} as unknown as DbOrTx;

/** BreakerRedis fake: programmable window totals + call recording. */
class FakeBreakerRedis implements BreakerRedis {
  readonly outcomes: { base: string; isFail: boolean }[] = [];
  readonly cleared: string[] = [];
  constructor(private readonly window: BreakerWindow = { total: 0, fail: 0 }) {}

  recordOutcome(base: string, _windowMs: number, isFail: boolean): Promise<BreakerWindow> {
    this.outcomes.push({ base, isFail });
    return Promise.resolve(this.window);
  }
  readWindow(): Promise<BreakerWindow> {
    return Promise.resolve(this.window);
  }
  tryTrial(): Promise<boolean> {
    return Promise.resolve(true);
  }
  clearWindow(base: string): Promise<void> {
    this.cleared.push(base);
    return Promise.resolve();
  }
}

/** Recording slice-1 persistence fakes. */
function fakeQueries(o: { row?: SupplyOfferingBreakerRow } = {}): {
  upserts: { offeringId: string; snapshot: SupplyOfferingBreakerSnapshotInput }[];
  loads: number;
  queries: {
    getSupplyOfferingBreakers: (
      db: DbOrTx,
      ids: string[],
    ) => Promise<Map<string, SupplyOfferingBreakerRow>>;
    upsertSupplyOfferingBreaker: (
      db: DbOrTx,
      offeringId: string,
      snapshot: SupplyOfferingBreakerSnapshotInput,
    ) => Promise<SupplyOfferingBreakerRow>;
  };
} {
  const upserts: { offeringId: string; snapshot: SupplyOfferingBreakerSnapshotInput }[] = [];
  const state = { loads: 0 };
  return {
    upserts,
    get loads() {
      return state.loads;
    },
    queries: {
      getSupplyOfferingBreakers: (_db, ids) => {
        state.loads += 1;
        const map = new Map<string, SupplyOfferingBreakerRow>();
        if (o.row !== undefined && ids.includes(o.row.offeringId)) map.set(o.row.offeringId, o.row);
        return Promise.resolve(map);
      },
      upsertSupplyOfferingBreaker: (_db, offeringId, snapshot) => {
        upserts.push({ offeringId, snapshot });
        return Promise.resolve(breakerRow(offeringId, { state: snapshot.state }));
      },
    },
  };
}

describe('recordOfferingOutcome — FSM wiring (§2.5, pure breaker.ts transitions)', () => {
  it('half_open success reaching the threshold closes the breaker and clears the window', async () => {
    const redis = new FakeBreakerRedis();
    const fx = fakeQueries({
      row: breakerRow('off-1', { state: 'half_open', halfOpenSuccesses: 1, consecutiveOpens: 2 }),
    });
    await recordOfferingOutcome(
      { db: DB, redis, queries: fx.queries },
      { offeringId: 'off-1', outcome: 'success', cfg: DEFAULT_BREAKER_CONFIG, now: NOW },
    );
    expect(redis.outcomes).toEqual([{ base: 'offering:off-1', isFail: false }]);
    expect(fx.upserts).toEqual([
      {
        offeringId: 'off-1',
        snapshot: { state: 'closed', openedAt: null, halfOpenSuccesses: 0, consecutiveOpens: 0 },
      },
    ]);
    expect(redis.cleared).toEqual(['offering:off-1']); // stale burst can't re-trip
  });

  it('a success on a closed breaker records the sample but persists nothing', async () => {
    const redis = new FakeBreakerRedis();
    const fx = fakeQueries();
    await recordOfferingOutcome(
      { db: DB, redis, queries: fx.queries },
      { offeringId: 'off-1', outcome: 'success', cfg: DEFAULT_BREAKER_CONFIG, now: NOW },
    );
    expect(redis.outcomes).toHaveLength(1);
    expect(fx.upserts).toEqual([]);
  });

  it('a 5xx failure at threshold volume+rate trips the breaker open', async () => {
    const redis = new FakeBreakerRedis({ total: 20, fail: 10 }); // 50% over 20 samples
    const fx = fakeQueries();
    await recordOfferingOutcome(
      { db: DB, redis, queries: fx.queries },
      {
        offeringId: 'off-1',
        outcome: 'failure',
        errorClass: '5xx',
        cfg: DEFAULT_BREAKER_CONFIG,
        now: NOW,
      },
    );
    expect(redis.outcomes).toEqual([{ base: 'offering:off-1', isFail: true }]);
    expect(fx.upserts).toHaveLength(1);
    expect(fx.upserts[0]?.snapshot).toMatchObject({
      state: 'open',
      openedAt: NOW,
      consecutiveOpens: 1,
    });
  });

  it('an unclassified failure defaults to protocol (breaker-eligible)', async () => {
    const redis = new FakeBreakerRedis({ total: 1, fail: 1 }); // under min volume → no trip
    const fx = fakeQueries();
    await recordOfferingOutcome(
      { db: DB, redis, queries: fx.queries },
      { offeringId: 'off-1', outcome: 'failure', cfg: DEFAULT_BREAKER_CONFIG, now: NOW },
    );
    expect(redis.outcomes).toEqual([{ base: 'offering:off-1', isFail: true }]);
    expect(fx.upserts).toEqual([]); // volume below min_volume → closed stays
  });
});

describe('recordOfferingOutcome — §2.4 attribution red line (429/401 never feed the breaker)', () => {
  it('a 429 contributes ZERO breaker samples and ZERO persistence', async () => {
    const redis = new FakeBreakerRedis({ total: 100, fail: 100 }); // would trip if fed
    const fx = fakeQueries();
    await recordOfferingOutcome(
      { db: DB, redis, queries: fx.queries },
      {
        offeringId: 'off-1',
        outcome: 'failure',
        errorClass: 'rate_limited',
        cfg: DEFAULT_BREAKER_CONFIG,
        now: NOW,
      },
    );
    expect(redis.outcomes).toEqual([]); // no window sample
    expect(fx.upserts).toEqual([]); // no FSM write
    expect(fx.loads).toBe(0); // the breaker state is not even read
  });

  it('a 401 likewise bypasses the breaker entirely', async () => {
    const redis = new FakeBreakerRedis({ total: 100, fail: 100 });
    const fx = fakeQueries();
    await recordOfferingOutcome(
      { db: DB, redis, queries: fx.queries },
      {
        offeringId: 'off-1',
        outcome: 'failure',
        errorClass: 'unauthorized',
        cfg: DEFAULT_BREAKER_CONFIG,
        now: NOW,
      },
    );
    expect(redis.outcomes).toEqual([]);
    expect(fx.upserts).toEqual([]);
  });
});

/**
 * STATEFUL persistence fake: upserts land in a mutable row so consecutive
 * recordOfferingOutcome calls observe each other — the lifecycle tests below
 * walk real multi-step FSM progressions.
 */
function statefulQueries(initial?: SupplyOfferingBreakerRow): {
  upserts: { offeringId: string; snapshot: SupplyOfferingBreakerSnapshotInput }[];
  queries: {
    getSupplyOfferingBreakers: (
      db: DbOrTx,
      ids: string[],
    ) => Promise<Map<string, SupplyOfferingBreakerRow>>;
    upsertSupplyOfferingBreaker: (
      db: DbOrTx,
      offeringId: string,
      snapshot: SupplyOfferingBreakerSnapshotInput,
    ) => Promise<SupplyOfferingBreakerRow>;
  };
} {
  let row = initial;
  const upserts: { offeringId: string; snapshot: SupplyOfferingBreakerSnapshotInput }[] = [];
  return {
    upserts,
    queries: {
      getSupplyOfferingBreakers: (_db, ids) => {
        const map = new Map<string, SupplyOfferingBreakerRow>();
        if (row !== undefined && ids.includes(row.offeringId)) map.set(row.offeringId, row);
        return Promise.resolve(map);
      },
      upsertSupplyOfferingBreaker: (_db, offeringId, snapshot) => {
        upserts.push({ offeringId, snapshot });
        row = {
          offeringId,
          state: snapshot.state,
          openedAt: snapshot.openedAt,
          halfOpenSuccesses: snapshot.halfOpenSuccesses,
          consecutiveOpens: snapshot.consecutiveOpens,
          updatedAt: snapshot.openedAt ?? NOW,
        };
        return Promise.resolve(row);
      },
    },
  };
}

describe('recordOfferingOutcome — §2.5 open→half_open→closed/reopen lifecycle (BUG-C regression)', () => {
  const cfg = DEFAULT_BREAKER_CONFIG; // cooldown 5s → ×2 per reopen → cap 300s
  const atMs = (ms: number): Date => new Date(NOW.getTime() + ms);

  it('a persistently-5xx offering re-opens on every elapsed-cooldown probe with MONOTONICALLY growing cooldown', async () => {
    const redis = new FakeBreakerRedis({ total: 20, fail: 20 });
    const fx = statefulQueries();
    const record = (now: Date): Promise<void> =>
      recordOfferingOutcome(
        { db: DB, redis, queries: fx.queries },
        { offeringId: 'off-1', outcome: 'failure', errorClass: '5xx', cfg, now },
      );

    // Trip: closed → open, consecutive_opens=1 (cooldown 5s).
    await record(NOW);
    // Probe #1 at +5s (cooldown elapsed → this outcome is the half-open probe):
    // failure → REOPEN with consecutive_opens=2 (cooldown now 10s).
    await record(atMs(5_000));
    // Probe #2 at +15s (5s + the grown 10s): failure → consecutive_opens=3 (20s).
    await record(atMs(15_000));

    expect(fx.upserts.map((u) => u.snapshot.state)).toEqual(['open', 'open', 'open']);
    const opens = fx.upserts.map((u) => u.snapshot.consecutiveOpens);
    expect(opens).toEqual([1, 2, 3]);
    // Exponential backoff is LIVE again: each reopen's cooldown strictly grows.
    const cooldowns = opens.map((n) => cooldownMs(cfg, n - 1));
    expect(cooldowns).toEqual([5_000, 10_000, 20_000]);
    for (let i = 1; i < cooldowns.length; i += 1) {
      expect(cooldowns[i] ?? 0).toBeGreaterThan(cooldowns[i - 1] ?? 0);
    }
    // And each reopen re-stamps openedAt at the probe instant.
    expect(fx.upserts[1]?.snapshot.openedAt).toEqual(atMs(5_000));
    expect(fx.upserts[2]?.snapshot.openedAt).toEqual(atMs(15_000));
  });

  it('a recovered offering closes: open → (cooldown elapsed) probe success → half_open → threshold → closed', async () => {
    const redis = new FakeBreakerRedis();
    // open with consecutive_opens=2 (cooldown 10s), opened 20s ago → eligible.
    const fx = statefulQueries(
      breakerRow('off-1', {
        state: 'open',
        openedAt: atMs(-20_000),
        consecutiveOpens: 2,
        halfOpenSuccesses: 0,
      }),
    );
    const record = (): Promise<void> =>
      recordOfferingOutcome(
        { db: DB, redis, queries: fx.queries },
        { offeringId: 'off-1', outcome: 'success', cfg, now: NOW },
      );

    // Probe success #1: the open+eligible snapshot advances AS half_open.
    await record();
    expect(fx.upserts[0]?.snapshot).toMatchObject({ state: 'half_open', halfOpenSuccesses: 1 });
    // Probe success #2 reaches half_open_successes=2 → CLOSED, opens reset to 0.
    await record();
    expect(fx.upserts[1]?.snapshot).toEqual({
      state: 'closed',
      openedAt: null,
      halfOpenSuccesses: 0,
      consecutiveOpens: 0,
    });
    // Closing clears the window so a stale burst can't insta-re-trip.
    expect(redis.cleared).toEqual(['offering:off-1']);
  });

  it('is NOT the pre-fix pathology: an elapsed-cooldown open offering never sits open-forever — every probe outcome moves the FSM', async () => {
    // BEFORE the fix: onFailureTransition(open)=null and onSuccessTransition(
    // non-half_open)=null → past the first 5s cooldown the offering was
    // admitted forever while the state never advanced (no reopen, no backoff
    // growth, no close). Both directions must persist a transition now.
    const eligible = (): SupplyOfferingBreakerRow =>
      breakerRow('off-1', { state: 'open', openedAt: atMs(-6_000), consecutiveOpens: 1 });

    const failFx = statefulQueries(eligible());
    await recordOfferingOutcome(
      { db: DB, redis: new FakeBreakerRedis({ total: 1, fail: 1 }), queries: failFx.queries },
      { offeringId: 'off-1', outcome: 'failure', errorClass: 'timeout', cfg, now: NOW },
    );
    expect(failFx.upserts).toHaveLength(1); // reopen persisted (was: nothing)
    expect(failFx.upserts[0]?.snapshot).toMatchObject({ state: 'open', consecutiveOpens: 2 });

    const okFx = statefulQueries(eligible());
    await recordOfferingOutcome(
      { db: DB, redis: new FakeBreakerRedis(), queries: okFx.queries },
      { offeringId: 'off-1', outcome: 'success', cfg, now: NOW },
    );
    expect(okFx.upserts).toHaveLength(1); // half_open progress persisted (was: nothing)
    expect(okFx.upserts[0]?.snapshot).toMatchObject({ state: 'half_open', halfOpenSuccesses: 1 });
  });

  it('an outcome landing while the cooldown still RUNS moves nothing (in-flight stragglers)', async () => {
    // open 1s ago with a 5s cooldown → NOT eligible: open→x stays impossible.
    const row = (): SupplyOfferingBreakerRow =>
      breakerRow('off-1', { state: 'open', openedAt: atMs(-1_000), consecutiveOpens: 1 });

    const failFx = statefulQueries(row());
    await recordOfferingOutcome(
      { db: DB, redis: new FakeBreakerRedis({ total: 50, fail: 50 }), queries: failFx.queries },
      { offeringId: 'off-1', outcome: 'failure', errorClass: '5xx', cfg, now: NOW },
    );
    expect(failFx.upserts).toEqual([]);

    const okFx = statefulQueries(row());
    await recordOfferingOutcome(
      { db: DB, redis: new FakeBreakerRedis(), queries: okFx.queries },
      { offeringId: 'off-1', outcome: 'success', cfg, now: NOW },
    );
    expect(okFx.upserts).toEqual([]);
  });
});

describe('recordCredentialCooldown — §2.4 cooldown writes (max semantics, BUG-E)', () => {
  /** Recording cooldown deps over a credential row with the given existing cooldown. */
  function cooldownHarness(existing: Date | null): {
    updates: { id: string; patch: UpdateSupplyCredentialInput }[];
    deps: Parameters<typeof recordCredentialCooldown>[0];
  } {
    const updates: { id: string; patch: UpdateSupplyCredentialInput }[] = [];
    return {
      updates,
      deps: {
        db: DB,
        queries: {
          getSupplyCredentialById: (_db: DbOrTx, id: string): Promise<SupplyCredentialRow> =>
            Promise.resolve({ ...credential(id, 'chan-1'), cooldownUntil: existing }),
          updateSupplyCredential: (_db, id, patch) => {
            updates.push({ id, patch });
            return Promise.resolve(credential(id, 'chan-1'));
          },
        },
      },
    };
  }

  it('stamps cooldown_until = now + cooldownMs on the credential (429)', async () => {
    const h = cooldownHarness(null);
    await recordCredentialCooldown(h.deps, {
      credentialId: 'cred-1',
      now: NOW,
      cooldownMs: 30_000,
      reason: '429',
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.id).toBe('cred-1');
    expect(h.updates[0]?.patch.cooldownUntil?.getTime()).toBe(NOW.getTime() + 30_000);
  });

  it('401 attribution cools the credential the same way', async () => {
    const h = cooldownHarness(null);
    await recordCredentialCooldown(h.deps, {
      credentialId: 'cred-9',
      now: NOW,
      cooldownMs: 60_000,
      reason: '401',
    });
    expect(h.updates[0]?.patch.cooldownUntil?.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('a concurrent SHORT cooldown (429) never truncates a LONGER one already stamped (401)', async () => {
    // Existing: a 401 long cooldown reaching NOW+60s. A racing 429's 30s
    // cooldown must NOT overwrite it — max(existing, now+cd) keeps the 60s.
    const h = cooldownHarness(new Date(NOW.getTime() + 60_000));
    await recordCredentialCooldown(h.deps, {
      credentialId: 'cred-1',
      now: NOW,
      cooldownMs: 30_000,
      reason: '429',
    });
    expect(h.updates).toEqual([]); // skipped entirely — the stored cooldown wins
  });

  it('a LONGER new cooldown still extends past a shorter existing one', async () => {
    const h = cooldownHarness(new Date(NOW.getTime() + 10_000));
    await recordCredentialCooldown(h.deps, {
      credentialId: 'cred-1',
      now: NOW,
      cooldownMs: 120_000,
      reason: '401',
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.patch.cooldownUntil?.getTime()).toBe(NOW.getTime() + 120_000);
  });
});

describe('selectCredential — §7.8 step 4 in-pool rotation', () => {
  const pool = [credential('c1', 'chan-1'), credential('c2', 'chan-1'), credential('c3', 'chan-1')];
  const deps = {
    db: DB,
    queries: {
      listActiveCredentialsForChannel: () => Promise.resolve(pool),
    },
  };

  it('rotates deterministically under an injected rng', async () => {
    const first = await selectCredential(deps, { channelId: 'chan-1', now: NOW, rng: () => 0 });
    const middle = await selectCredential(deps, { channelId: 'chan-1', now: NOW, rng: () => 0.5 });
    const last = await selectCredential(deps, { channelId: 'chan-1', now: NOW, rng: () => 0.999 });
    expect(first?.id).toBe('c1');
    expect(middle?.id).toBe('c2');
    expect(last?.id).toBe('c3');
  });

  it('an empty (all-cooling) pool yields undefined — half-open probes cannot bypass cooldown', async () => {
    // The pool query IS the cooldown filter (slice 1), so a probe request
    // selecting a key here can never see a cooling credential (§2.5).
    const empty = {
      db: DB,
      queries: { listActiveCredentialsForChannel: () => Promise.resolve([]) },
    };
    const picked = await selectCredential(empty, { channelId: 'chan-1', now: NOW, rng: () => 0 });
    expect(picked).toBeUndefined();
  });
});
