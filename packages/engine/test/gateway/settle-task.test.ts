// 批次4 slice2 — §9.2 双卡 settle red lines: 成本卡 ‖ 售价卡 → 倍率组 → 租户
// 折扣, 封顶 holdAmount, 价格快照 (sale/cost card id+version) into the ledger
// envelope, estimated 标志; and the no-charge fail twin (§3 at-most-once 不扣费).
import type { Modifier } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  computeDualSettle,
  failGatewayResult,
  type GatewaySettleDeps,
  priceCardEntry,
  settleGatewayResult,
  snapshotRef,
} from '../../src/index.js';
import {
  cardRow,
  costCardRow,
  fakeReservation,
  fakeSettleStore,
  fakeTaskStore,
  POISONED_DB,
  saleCardRow,
  taskRowOf,
} from './gateway-fixtures.js';

const USAGE = (
  metrics: Record<string, number>,
  estimated = false,
): {
  metrics: Record<string, number>;
  billingDims: Record<string, never>;
  estimated: boolean;
} => ({ metrics, billingDims: {}, estimated });

/** 20% off tenant discount (§9.2 售价侧). */
const DISCOUNT: Modifier = {
  id: 'tenant-20-off',
  scope: 'tenant',
  op: 'percent_off',
  value: 20,
  stackable: false,
  priority: 0,
  version: 1,
};

describe('computeDualSettle (§9.2 双卡叠加, pure)', () => {
  it('sale side: usage-priced card → modifier stack → final; cost side computed INDEPENDENTLY, no modifiers', () => {
    const sale = cardRow({
      id: 'card-sale',
      version: 3,
      spec: { method: 'unit', dimensions: { output_tokens: { rate: 2 } } },
    });
    const cost = cardRow({
      id: 'card-cost',
      version: 1,
      spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
    });

    const r = computeDualSettle({
      saleCard: sale,
      costCard: cost,
      billingDims: {},
      upstreamInputs: {},
      usage: USAGE({ output_tokens: 100 }),
      modifiers: [DISCOUNT],
      holdAmount: 5_000n,
    });

    expect(r.finalCost).toBe(160n); // 100×2 = 200 → -20% = 160 (售价侧)
    expect(r.costSide).toBe(100n); // 100×1 — NO modifiers on the cost side
    expect(r.estimated).toBe(false);
    expect(r.applied).toEqual([{ id: 'tenant-20-off', version: 1, before: '200', after: '160' }]);
  });

  it('封顶: the modifier-adjusted sale charge is CAPPED at holdAmount', () => {
    const sale = cardRow({
      id: 'card-sale',
      spec: { method: 'unit', dimensions: { output_tokens: { rate: 2 } } },
    });
    const r = computeDualSettle({
      saleCard: sale,
      costCard: null,
      billingDims: {},
      upstreamInputs: {},
      usage: USAGE({ output_tokens: 10_000 }), // would be 20_000µ
      modifiers: [],
      holdAmount: 5_000n,
    });
    expect(r.finalCost).toBe(5_000n); // §9.2 封顶 — never settle above the hold
  });

  it('no usage at all → charges the hold ceiling and flags estimated', () => {
    const r = computeDualSettle({
      saleCard: saleCardRow(),
      costCard: null,
      billingDims: {},
      upstreamInputs: {},
      usage: USAGE({}),
      modifiers: [],
      holdAmount: 5_000n,
    });
    expect(r.finalCost).toBe(5_000n);
    expect(r.estimated).toBe(true); // §9.2 estimated 标志
  });

  it('cost-side computation failure degrades to null — it must never fail a billable settle (对账降级)', () => {
    const broken = cardRow({ id: 'card-cost' });
    (broken as { spec: unknown }).spec = { method: 'not-a-method' };
    const r = computeDualSettle({
      saleCard: saleCardRow(),
      costCard: broken,
      billingDims: {},
      upstreamInputs: {},
      usage: USAGE({ requests: 1 }),
      modifiers: [],
      holdAmount: 9_000n,
    });
    expect(r.finalCost).toBe(5_000n); // sale side untouched
    expect(r.costSide).toBeNull();
  });

  it('priceCardEntry timing parity with the gate: fixed pre-quotes; unit is post; credits pre-quotes iff dims complete', () => {
    expect(priceCardEntry(saleCardRow(), {}).timing).toBe('pre');
    expect(
      priceCardEntry(
        cardRow({ id: 'c', spec: { method: 'unit', dimensions: { s: { rate: 1 } } } }),
        {},
      ).timing,
    ).toBe('post');
    const credits = cardRow({
      id: 'c2',
      spec: {
        method: 'credits',
        creditValueMicroUsd: 10,
        baseCredits: 0,
        dimensions: { duration: { credits: 5 } },
      },
    });
    expect(priceCardEntry(credits, { duration: 5 }).timing).toBe('pre');
    expect(priceCardEntry(credits, {}).timing).toBe('post');
  });
});

describe('settleGatewayResult (§9.2 快照 + §7.5 hook + slot-only release)', () => {
  function deps(o: { taskStore?: ReturnType<typeof fakeTaskStore> } = {}): {
    deps: GatewaySettleDeps;
    store: ReturnType<typeof fakeSettleStore>;
  } {
    const store = fakeSettleStore({
      cards: [saleCardRow(), costCardRow()],
      ...(o.taskStore !== undefined ? { taskStore: o.taskStore } : {}),
    });
    const settleDeps: GatewaySettleDeps = {
      db: POISONED_DB,
      repo: {
        ...store.repo,
        ...(o.taskStore !== undefined ? { transitionTask: o.taskStore.repo.transitionTask } : {}),
      },
    };
    return { deps: settleDeps, store };
  }

  const baseInput = (
    reservation: ReturnType<typeof fakeReservation>['reservation'],
  ): Parameters<typeof settleGatewayResult>[1] => ({
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subjectId: null,
    wallet: { kind: 'tenant', accountId: 'acct-1', tenantId: 'tenant-1' },
    holdAmount: 5_000n,
    saleCardRef: { cardId: 'card-sale', version: 3 },
    costCardRef: { cardId: 'card-cost', version: 1 },
    billingDims: { resolution: '720p' },
    upstreamInputs: { size: '1280x720' },
    modifiers: [],
    usage: { metrics: { requests: 1 }, billingDims: {}, estimated: false },
    output: { url: 'https://x' },
    offeringId: 'off-1',
    reservation,
  });

  it('stamps the §9.2 price snapshot (sale+cost card id+version) into the ledger envelope and releases the SLOT only', async () => {
    const { reservation, log } = fakeReservation();
    const { deps: d, store } = deps();

    const out = await settleGatewayResult(d, baseInput(reservation));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.finalCost).toBe(5_000n);
    expect(store.settles).toHaveLength(1);
    expect(store.settles[0]).toMatchObject({
      saleCardRef: { card_id: 'card-sale', version: 3 },
      costCardRef: { card_id: 'card-cost', version: 1 },
      resourceId: 'supply_offering:off-1',
    });
    const envelope = store.settles[0]?.modifiersApplied as Record<string, unknown>;
    expect(envelope.sale_card_ref).toEqual({ card_id: 'card-sale', version: 3 });
    expect(envelope.cost_card_ref).toEqual({ card_id: 'card-cost', version: 1 });
    expect(envelope.cost_side_credits).toBe('1000');
    // hold 转 settle: slot only — release() (hold rollback) must NOT run
    expect(log).toEqual(['release:slot']);
  });

  it('§7.5 requirePersist: persist failure takes the FAIL path — task failed, hold rolled back, ok:false, no settle', async () => {
    const taskStore = fakeTaskStore();
    const task = taskRowOf({ status: 'running' });
    taskStore.tasks.set(task.id, task);
    const { reservation, log } = fakeReservation();
    const { deps: d, store } = deps({ taskStore });

    const out = await settleGatewayResult(d, {
      ...baseInput(reservation),
      task,
      requirePersist: true,
      persist: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'internal_error', message: 'R2 down', retryable: true, failover: false },
        }),
    });

    expect(out.ok).toBe(false);
    expect(store.settles).toEqual([]); // §7.5 失败即 fail 不扣费
    expect(taskStore.tasks.get(task.id)?.status).toBe('failed');
    expect(log).toContain('release:full');
  });

  it('persist success may substitute the delivered output (转存 URL 替换)', async () => {
    const { reservation } = fakeReservation();
    const { deps: d, store } = deps();

    const out = await settleGatewayResult(d, {
      ...baseInput(reservation),
      persist: () => Promise.resolve({ ok: true, output: { url: 'https://platform/x' } }),
    });

    expect(out.ok).toBe(true);
    expect(store.settles[0]?.output).toEqual({ url: 'https://platform/x' });
  });

  it('BUG1 回归: hold↔settle 间售价/成本卡被软删 → settle 仍按快照卡真实计量(非收顶), 快照 ref 正确', async () => {
    const { reservation, log } = fakeReservation();
    // Both cards soft-deleted AFTER the hold — §2.7: the {card_id, version}
    // snapshot must still reconstruct the exact price (rows are immutable).
    const deletedSale = cardRow({
      id: 'card-sale',
      version: 3,
      spec: { method: 'unit', dimensions: { output_tokens: { rate: 2 } } },
      deletedAt: new Date('2026-07-12T11:59:00.000Z'),
    });
    const deletedCost = cardRow({
      id: 'card-cost',
      version: 1,
      spec: { method: 'unit', dimensions: { output_tokens: { rate: 1 } } },
      deletedAt: new Date('2026-07-12T11:59:00.000Z'),
    });
    const store = fakeSettleStore({ cards: [deletedSale, deletedCost] });
    const d: GatewaySettleDeps = { db: POISONED_DB, repo: store.repo };

    const out = await settleGatewayResult(d, {
      ...baseInput(reservation),
      usage: { metrics: { output_tokens: 100 }, billingDims: {}, estimated: false },
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.finalCost).toBe(200n); // 真实计量 100×2 — NOT the 5000n hold ceiling (超收)
    expect(out.estimated).toBe(false);
    const envelope = store.settles[0]?.modifiersApplied as Record<string, unknown>;
    expect(envelope.sale_card_missing).toBeUndefined(); // soft-deleted ≠ missing
    expect(envelope.cost_side_credits).toBe('100'); // cost card rebuilt too
    expect(store.settles[0]).toMatchObject({
      saleCardRef: { card_id: 'card-sale', version: 3 },
      costCardRef: { card_id: 'card-cost', version: 1 },
    });
    expect(log).toEqual(['release:slot']); // hold 转 settle unchanged
  });

  it('sale card id NEVER existed (hard drift, not soft delete) → charges the hold ceiling, flags the snapshot', async () => {
    const { reservation } = fakeReservation();
    const store = fakeSettleStore({ cards: [costCardRow()] }); // sale card absent entirely
    const d: GatewaySettleDeps = { db: POISONED_DB, repo: store.repo };

    const out = await settleGatewayResult(d, baseInput(reservation));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.finalCost).toBe(5_000n);
    const envelope = store.settles[0]?.modifiersApplied as Record<string, unknown>;
    expect(envelope.sale_card_missing).toBe(true);
  });
});

describe('failGatewayResult (§3/§7.8 不扣费)', () => {
  it('with a live reservation: task → failed, then reservation.release() (hold rollback) — settle repo NEVER touched', async () => {
    const taskStore = fakeTaskStore();
    const task = taskRowOf({ status: 'running' });
    taskStore.tasks.set(task.id, task);
    const store = fakeSettleStore({ taskStore });
    const { reservation, log } = fakeReservation();
    const d: GatewaySettleDeps = {
      db: POISONED_DB,
      repo: { ...store.repo, transitionTask: taskStore.repo.transitionTask },
    };

    const r = await failGatewayResult(d, {
      error: { code: 'upstream_error', message: 'x', retryable: false, failover: false },
      task,
      reservation,
    });

    expect(r.failed).toBe(true);
    expect(taskStore.tasks.get(task.id)?.status).toBe('failed');
    expect(log).toContain('release:full');
    expect(store.settles).toEqual([]); // 不扣费
    expect(store.fails).toEqual([]); // reservation path never double-releases via the db twin
  });

  it('FOUND-3 回归: the row was ALREADY terminalized by another writer → transition no-ops → release SKIPPED (credit_held 不双放), failed:false', async () => {
    for (const terminal of ['failed', 'succeeded'] as const) {
      // e.g. the slice4 reaper failed the row and released its hold from the
      // row columns (terminal='failed'), or a racing settle charged it
      // (terminal='succeeded') — EITHER way that writer disposed of the hold.
      const taskStore = fakeTaskStore();
      const stale = taskRowOf({ status: 'running' }); // the runner's stale in-memory view
      taskStore.tasks.set(stale.id, { ...stale, status: terminal });
      const store = fakeSettleStore({ taskStore });
      const { reservation, log } = fakeReservation();
      const d: GatewaySettleDeps = {
        db: POISONED_DB,
        repo: { ...store.repo, transitionTask: taskStore.repo.transitionTask },
      };

      const r = await failGatewayResult(d, {
        error: { code: 'upstream_error', message: 'x', retryable: false, failover: false },
        task: stale,
        reservation,
      });

      expect(r.failed).toBe(false); // nothing moved by THIS caller
      expect(log).not.toContain('release:full'); // the hold is NOT rolled back a second time
      expect(taskStore.tasks.get(stale.id)?.status).toBe(terminal); // 终态不被覆盖
      expect(store.fails).toEqual([]); // the db twin is never invoked on the reservation path
    }
  });

  it('FOUND-3 对照: no task rides the reservation (keyless sync/stream) → release ALWAYS runs (nothing else can dispose the hold)', async () => {
    const store = fakeSettleStore({});
    const { reservation, log } = fakeReservation();
    const d: GatewaySettleDeps = { db: POISONED_DB, repo: store.repo };

    const r = await failGatewayResult(d, {
      error: { code: 'upstream_error', message: 'x', retryable: false, failover: false },
      reservation,
    });

    expect(r.failed).toBe(true);
    expect(log).toContain('release:full');
  });

  it('without a reservation (worker/recovery path): db failGatewayTask releases the hold from the task columns', async () => {
    const taskStore = fakeTaskStore();
    const task = taskRowOf({
      status: 'running',
      fetchMode: 'direct',
      holdAmount: 7_777n,
      accountId: 'acct-1',
    });
    taskStore.tasks.set(task.id, task);
    const store = fakeSettleStore({ taskStore });
    const d: GatewaySettleDeps = { db: POISONED_DB, repo: store.repo };

    const r = await failGatewayResult(d, {
      error: {
        code: 'internal_error',
        message: 'crash takeover',
        retryable: false,
        failover: false,
      },
      task,
    });

    expect(r.failed).toBe(true);
    expect(store.fails).toHaveLength(1);
    expect(store.fails[0]).toMatchObject({
      taskId: task.id,
      holdAmount: 7_777n,
      accountId: 'acct-1',
      to: 'failed',
    });
    expect(store.settles).toEqual([]); // at-most-once 崩溃不扣费
  });
});

describe('snapshotRef', () => {
  it('converts the planner ref to the frozen snake_case snapshot; null passes through', () => {
    expect(snapshotRef({ cardId: 'c1', version: 4 })).toEqual({ card_id: 'c1', version: 4 });
    expect(snapshotRef(null)).toBeNull();
  });
});
