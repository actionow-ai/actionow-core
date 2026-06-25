import { FakeBreakerRedis } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import {
  type BreakerConfig,
  type BreakerPersistence,
  type BreakerSnapshot,
  DEFAULT_BREAKER_CONFIG,
  DefaultBreakerStore,
} from '../src/breaker.js';

const t0 = new Date('2026-06-25T00:00:00Z');

/** A tiny in-memory {@link BreakerPersistence} stub keyed by `${channelId}:${model}`. */
class FakePersistence implements BreakerPersistence {
  readonly rows = new Map<string, BreakerSnapshot>();
  throwOnGet = false;
  readonly upserts: { channelId: string; model: string; snap: BreakerSnapshot }[] = [];

  constructor(seed?: Record<string, BreakerSnapshot>) {
    for (const [k, v] of Object.entries(seed ?? {})) this.rows.set(k, v);
  }

  getRows(
    channelIds: string[],
    model: string,
  ): Promise<({ channelId: string } & BreakerSnapshot)[]> {
    if (this.throwOnGet) return Promise.reject(new Error('pg down'));
    const out: ({ channelId: string } & BreakerSnapshot)[] = [];
    for (const id of channelIds) {
      const snap = this.rows.get(`${id}:${model}`);
      if (snap) out.push({ channelId: id, ...snap });
    }
    return Promise.resolve(out);
  }

  upsert(channelId: string, model: string, snap: BreakerSnapshot): Promise<void> {
    this.rows.set(`${channelId}:${model}`, snap);
    this.upserts.push({ channelId, model, snap });
    return Promise.resolve();
  }
}

const cfg: BreakerConfig = DEFAULT_BREAKER_CONFIG;

function makeStore(
  persistence: FakePersistence,
  redis = new FakeBreakerRedis(),
  configFor: (id: string) => Promise<BreakerConfig> = () => Promise.resolve(cfg),
) {
  const transitions: { channelId: string; from: string; to: string }[] = [];
  const store = new DefaultBreakerStore({
    redis,
    persistence,
    configFor,
    onTransition: (channelId, _model, from, to) => transitions.push({ channelId, from, to }),
  });
  return { store, redis, transitions };
}

function openSnap(cooldownUntil: Date): BreakerSnapshot {
  return { state: 'open', openedAt: t0, cooldownUntil, tripCount: 1, halfOpenSuccesses: 0 };
}
function halfOpenSnap(): BreakerSnapshot {
  return {
    state: 'half_open',
    openedAt: t0,
    cooldownUntil: t0,
    tripCount: 1,
    halfOpenSuccesses: 0,
  };
}

describe('DefaultBreakerStore (弹性2.0)', () => {
  it('onFailure trips a closed (channel,model) to open, persisting + auditing', async () => {
    const pg = new FakePersistence();
    const { store, redis, transitions } = makeStore(pg);
    // Drive the Redis window over min_volume at >= failure_rate before the failing call.
    for (let i = 0; i < cfg.minVolume; i += 1) {
      await redis.recordOutcome('c1:gpt', cfg.windowMs, true, t0.getTime());
    }
    await store.onFailure('c1', 'gpt', t0);

    const row = pg.rows.get('c1:gpt');
    expect(row?.state).toBe('open');
    expect(row?.tripCount).toBe(1);
    expect(row?.cooldownUntil?.getTime()).toBe(t0.getTime() + cfg.openCooldownMs);
    expect(transitions).toEqual([{ channelId: 'c1', from: 'closed', to: 'open' }]);
  });

  it('filterAvailable excludes an open row whose cooldown has not elapsed', async () => {
    const cooldownUntil = new Date(t0.getTime() + cfg.openCooldownMs);
    const pg = new FakePersistence({ 'c1:gpt': openSnap(cooldownUntil) });
    const { store } = makeStore(pg);
    const at = new Date(t0.getTime() + 1_000); // before cooldown
    const out = await store.filterAvailable([{ id: 'c1' }, { id: 'c2' }], 'gpt', at);
    expect(out.map((c) => c.id)).toEqual(['c2']);
  });

  it('filterAvailable trial-gates a half_open row: first request admitted, the next excluded', async () => {
    const pg = new FakePersistence({ 'c1:gpt': halfOpenSnap() });
    // half_open_trial = 1 so the first request claims the only slot; the next
    // (same channel+model, shared trial key) is excluded.
    const trialCfg: BreakerConfig = { ...cfg, halfOpenTrial: 1 };
    const redis = new FakeBreakerRedis();
    const { store } = makeStore(pg, redis, () => Promise.resolve(trialCfg));
    const first = await store.filterAvailable([{ id: 'c1' }], 'gpt', t0);
    expect(first.map((c) => c.id)).toEqual(['c1']); // probe admitted
    const second = await store.filterAvailable([{ id: 'c1' }], 'gpt', t0);
    expect(second.map((c) => c.id)).toEqual([]); // slot exhausted
  });

  it('filterAvailable lazily promotes an elapsed-open row to half_open then trial-gates it', async () => {
    const cooldownUntil = new Date(t0.getTime() + cfg.openCooldownMs);
    const pg = new FakePersistence({ 'c1:gpt': openSnap(cooldownUntil) });
    const { store } = makeStore(pg, new FakeBreakerRedis(), () =>
      Promise.resolve({ ...cfg, halfOpenTrial: 1 }),
    );
    const at = new Date(cooldownUntil.getTime() + 1); // cooldown elapsed
    const out = await store.filterAvailable([{ id: 'c1' }], 'gpt', at);
    expect(out.map((c) => c.id)).toEqual(['c1']); // this request is the probe
    expect(pg.rows.get('c1:gpt')?.state).toBe('half_open');
  });

  it('filterAvailable fails open (returns all) when the store throws', async () => {
    const pg = new FakePersistence();
    pg.throwOnGet = true;
    const { store } = makeStore(pg);
    const out = await store.filterAvailable([{ id: 'c1' }, { id: 'c2' }], 'gpt', t0);
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('onSuccess in half_open advances to closed at the success threshold (clears window)', async () => {
    const pg = new FakePersistence({
      'c1:gpt': {
        state: 'half_open',
        openedAt: t0,
        cooldownUntil: t0,
        tripCount: 2,
        halfOpenSuccesses: 1,
      },
    });
    const { store, transitions } = makeStore(pg); // half_open_successes default = 2
    await store.onSuccess('c1', 'gpt', t0);
    expect(pg.rows.get('c1:gpt')?.state).toBe('closed');
    expect(pg.rows.get('c1:gpt')?.tripCount).toBe(0);
    expect(transitions).toEqual([{ channelId: 'c1', from: 'half_open', to: 'closed' }]);
  });

  it('onSuccess/onFailure swallow store errors (best-effort, never throw)', async () => {
    const pg = new FakePersistence();
    pg.throwOnGet = true;
    const { store } = makeStore(pg);
    await expect(store.onSuccess('c1', 'gpt', t0)).resolves.toBeUndefined();
    await expect(store.onFailure('c1', 'gpt', t0)).resolves.toBeUndefined();
  });
});
