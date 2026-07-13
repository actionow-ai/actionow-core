// 批次4 slice4 — task-recovery tests: §7.2 lease takeover + poll-to-terminal,
// 失主立即停手, §7.4 submit-uncertain 宁可失败 (never re-submit), §3 direct
// orphans failed WITHOUT charge, §7.3 hold-expiry backstop, §3 双保险
// callback+poll double-write converging on ONE settle via the from-guard, and
// the §7.6 terminal/progress envelopes emitted exactly once by the winner.
import type { GatewayUsage, TaskUpdate } from '@actionow/contracts';
import type {
  SupplyChannelRow,
  SupplyOfferingRow,
  TaskRow,
  WebhookDeliveryRow,
} from '@actionow/db';
import { describe, expect, it } from 'vitest';

import type {
  TaskRecoveryDeps,
  TaskRecoveryQueries,
  TaskRecoveryRepo,
  TaskWebhookEventType,
} from '../../src/index.js';
import {
  applyTaskUpdate,
  reapExpiredHoldGatewayTasks,
  reapOrphanedDirectTasks,
  reconstructSettleBase,
  recoverClaimedTask,
  sweepRecoverableTasks,
} from '../../src/index.js';
import { credential } from '../planner/supply-fixtures.js';
import {
  fakeHttp,
  type FakeHttpScript,
  fakeSettleStore,
  fakeTaskStore,
  NOW,
  offering,
  POISONED_DB,
  providerRow,
  registryWith,
  stubDialect,
  taskRowOf,
} from './gateway-fixtures.js';

// --- harness ---------------------------------------------------------------------

interface RecoveryHarness {
  deps: TaskRecoveryDeps;
  taskStore: ReturnType<typeof fakeTaskStore>;
  settleStore: ReturnType<typeof fakeSettleStore>;
  http: ReturnType<typeof fakeHttp>;
  emitted: { taskId: string; type: TaskWebhookEventType }[];
  log: string[];
  clock: { t: number };
  /** Per-task renew verdicts; default true. */
  renewVerdict: { value: boolean };
}

function recoveryTask(over: Partial<TaskRow> = {}): TaskRow {
  return taskRowOf({
    status: 'running',
    fetchMode: 'submit_poll',
    operation: 'video.generation',
    offeringId: 'off-1',
    upstreamTaskId: 'up-1',
    accountId: 'acct-1',
    holdAmount: 5_000n,
    maxRunTimeSeconds: 600,
    createdAt: NOW,
    startedAt: NOW,
    holdExpiresAt: new Date(NOW.getTime() + 720_000), // max_run 600s + buffer
    ownerNode: 'node-dead',
    leaseUntil: new Date(NOW.getTime() - 60_000), // expired — takeover due
    saleCardRef: { card_id: 'card-sale', version: 3 },
    costCardRef: { card_id: 'card-cost', version: 1 },
    internalSubstate: 'upstream_submitted',
    callbackUrl: 'https://consumer.example/hook',
    inputs: {
      model: 'test-model',
      effective: { canonical: { size: '1024' }, upstream: { size: '1024' } },
      billingDims: { size: '1024' },
      modifiers: [],
      options: {},
    },
    ...over,
  });
}

function harness(o: { http?: FakeHttpScript; tasks?: TaskRow[] } = {}): RecoveryHarness {
  const log: string[] = [];
  const taskStore = fakeTaskStore(log);
  for (const t of o.tasks ?? []) taskStore.tasks.set(t.id, t);
  const settleStore = fakeSettleStore({ taskStore, log });
  const http = fakeHttp(o.http ?? { responses: [] }, log);
  const clock = { t: NOW.getTime() };
  const renewVerdict = { value: true };
  const emitted: RecoveryHarness['emitted'] = [];

  const repo: TaskRecoveryRepo = {
    listRecoverableTasksForTakeover: (_db, now) =>
      Promise.resolve(
        [...taskStore.tasks.values()].filter(
          (t) =>
            t.status === 'running' &&
            (t.fetchMode === 'submit_poll' || t.fetchMode === 'submit_callback') &&
            (t.leaseUntil === null || t.leaseUntil.getTime() < now.getTime()),
        ),
      ),
    claimTaskLease: (_db, taskId, ownerNode, leaseUntil) => {
      const row = taskStore.tasks.get(taskId);
      if (row?.status !== 'running') return Promise.resolve(false);
      const claimable =
        row.ownerNode === null ||
        row.ownerNode === ownerNode ||
        (row.leaseUntil !== null && row.leaseUntil.getTime() < clock.t);
      if (!claimable) return Promise.resolve(false);
      taskStore.tasks.set(taskId, { ...row, ownerNode, leaseUntil });
      log.push('lease:claim');
      return Promise.resolve(true);
    },
    renewTaskLease: (_db, taskId, ownerNode, leaseUntil) => {
      log.push('lease:renew');
      if (!renewVerdict.value) return Promise.resolve(false);
      const row = taskStore.tasks.get(taskId);
      if (row?.ownerNode !== ownerNode) return Promise.resolve(false);
      taskStore.tasks.set(taskId, { ...row, leaseUntil });
      return Promise.resolve(true);
    },
    getTaskById: (_db, taskId) => Promise.resolve(taskStore.tasks.get(taskId)),
    transitionTask: taskStore.repo.transitionTask,
    listOrphanedDirectTasks: (_db, now) =>
      Promise.resolve(
        [...taskStore.tasks.values()].filter(
          (t) =>
            t.status === 'running' &&
            t.fetchMode === 'direct' &&
            t.holdExpiresAt !== null &&
            t.holdExpiresAt.getTime() < now.getTime(),
        ),
      ),
    listExpiredHoldGatewayTasks: (_db, now) =>
      Promise.resolve(
        [...taskStore.tasks.values()].filter(
          (t) =>
            (t.status === 'running' || t.status === 'pending') &&
            t.fetchMode !== 'direct' &&
            t.holdExpiresAt !== null &&
            t.holdExpiresAt.getTime() < now.getTime(),
        ),
      ),
  };

  const cand = offering({ id: 'off-1', channelId: 'chan-1', mode: 'submit_poll' });
  const channelRow = {
    ...cand.channel,
    baseUrl: 'https://upstream.test',
    faultPolicyId: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  } as unknown as SupplyChannelRow;

  const queries: TaskRecoveryQueries = {
    getSupplyOfferingById: (_db, id) =>
      Promise.resolve(id === 'off-1' ? (cand as SupplyOfferingRow) : undefined),
    getSupplyChannelById: (_db, id) => Promise.resolve(id === 'chan-1' ? channelRow : undefined),
    getSupplyProviderById: () => Promise.resolve(providerRow()),
    listActiveCredentialsForChannel: (_db, channelId) =>
      Promise.resolve([credential('cred-1', channelId)]),
    resolveSupplyCredentialSecret: () =>
      Promise.resolve({ scheme: 'bearer', api_key: 'sk-mock-1234' } as const),
  };

  const deps: TaskRecoveryDeps = {
    db: POISONED_DB,
    dialectRegistry: registryWith(stubDialect()),
    spiHttp: http,
    ownerNode: 'node-A',
    now: () => new Date(clock.t),
    nowMs: () => clock.t,
    // Advance the injected clock instead of sleeping — poll cadence becomes
    // simulated time, so budget-exhaustion tests terminate deterministically.
    sleep: (ms: number) => {
      clock.t += Math.max(ms, 1);
      return Promise.resolve();
    },
    rng: () => 0.5, // jitter factor 1.0 exactly
    repo,
    queries,
    settleRepo: settleStore.repo,
    emitTaskWebhook: (_db, task, type) => {
      emitted.push({ taskId: task.id, type });
      return Promise.resolve(undefined as unknown as WebhookDeliveryRow | undefined);
    },
  };

  return { deps, taskStore, settleStore, http, emitted, log, clock, renewVerdict };
}

const RUNNING_40 = { taskId: 'up-1', status: 'running', progress: 40 };
const SUCCEEDED = {
  taskId: 'up-1',
  status: 'succeeded',
  output: { url: 'https://cdn.example/v.mp4' },
  usage: { metrics: { seconds: 6 }, billingDims: {}, estimated: false } satisfies GatewayUsage,
};

// --- §7.2 takeover + poll to terminal -------------------------------------------------

describe('sweepRecoverableTasks — §7.2 lease takeover', () => {
  it('claims an expired-lease submit_poll task and polls it to settle (§9.2 reconstructed inputs)', async () => {
    const task = recoveryTask();
    const h = harness({
      tasks: [task],
      http: {
        responses: [
          { status: 200, body: RUNNING_40 },
          { status: 200, body: SUCCEEDED },
        ],
      },
    });

    const summary = await sweepRecoverableTasks(h.deps);

    expect(summary).toMatchObject({ scanned: 1, claimed: 1 });
    expect(summary.outcomes.settled).toBe(1);
    // The poll drove the REAL SPI pipeline against the stub dialect.
    expect(h.http.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/mock/tasks/up-1',
      '/mock/tasks/up-1',
    ]);
    // The settle reconstructed EVERYTHING from the row (slice2 contract).
    expect(h.settleStore.settles).toHaveLength(1);
    expect(h.settleStore.settles[0]).toMatchObject({
      taskId: task.id,
      tenantId: 'tenant-1',
      accountId: 'acct-1',
      holdAmount: 5_000n,
      saleCardRef: { card_id: 'card-sale', version: 3 },
      costCardRef: { card_id: 'card-cost', version: 1 },
      output: { url: 'https://cdn.example/v.mp4' },
    });
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('succeeded');
    // §7.6: progress + terminal envelopes, each exactly once.
    expect(h.emitted).toEqual([
      { taskId: task.id, type: 'task.progress' },
      { taskId: task.id, type: 'task.succeeded' },
    ]);
  });

  it('never lists direct tasks for takeover (§7.2 范围收窄 — repo-level guard honored)', async () => {
    const direct = recoveryTask({ fetchMode: 'direct', upstreamTaskId: null });
    const h = harness({ tasks: [direct] });
    const summary = await sweepRecoverableTasks(h.deps);
    expect(summary.scanned).toBe(0);
    expect(h.http.requests).toHaveLength(0);
    expect(h.taskStore.tasks.get(direct.id)?.status).toBe('running'); // untouched
  });

  it('tolerates a single failed poll probe (§3 单次失败重试不一错即败)', async () => {
    const task = recoveryTask();
    const h = harness({
      tasks: [task],
      http: {
        responses: [
          { status: 500, body: {} },
          { status: 200, body: SUCCEEDED },
        ],
      },
    });
    const summary = await sweepRecoverableTasks(h.deps);
    expect(summary.outcomes.settled).toBe(1);
    expect(h.settleStore.settles).toHaveLength(1);
    expect(h.settleStore.fails).toHaveLength(0);
  });

  it('stops INSTANTLY when the lease is lost (renew=false): no probe, no settle, no fail', async () => {
    const task = recoveryTask();
    const h = harness({ tasks: [task], http: { responses: [{ status: 200, body: SUCCEEDED }] } });
    h.renewVerdict.value = false; // another node took the lease right after our claim

    const summary = await sweepRecoverableTasks(h.deps);

    expect(summary.outcomes.lease_lost).toBe(1);
    expect(h.http.requests).toHaveLength(0); // renew runs BEFORE every probe
    expect(h.settleStore.settles).toHaveLength(0);
    expect(h.settleStore.fails).toHaveLength(0);
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('running'); // untouched
  });

  it('budget exhaustion fails with upstream_timeout and NO charge (§7.3 口径)', async () => {
    const task = recoveryTask();
    const h = harness({
      tasks: [task],
      http: { responses: [{ status: 200, body: { taskId: 'up-1', status: 'running' } }] },
    });
    const summary = await sweepRecoverableTasks(h.deps);
    expect(summary.outcomes.timeout).toBe(1);
    expect(h.settleStore.settles).toHaveLength(0);
    expect(h.settleStore.fails).toHaveLength(1);
    expect(h.settleStore.fails[0]).toMatchObject({
      taskId: task.id,
      holdAmount: 5_000n, // hold released, nothing charged
      error: expect.objectContaining({ code: 'upstream_timeout' }),
    });
    expect(h.emitted).toEqual([{ taskId: task.id, type: 'task.failed' }]);
  });
});

// --- §7.4 提交防重 -----------------------------------------------------------------

describe('recoverClaimedTask — §7.4 submit-uncertain 宁可失败', () => {
  it('a taken-over row WITHOUT an upstream handle is failed, never re-submitted', async () => {
    const task = recoveryTask({ upstreamTaskId: null, internalSubstate: 'submit_uncertain' });
    const h = harness({ tasks: [task] });

    const outcome = await recoverClaimedTask(h.deps, task);

    expect(outcome.kind).toBe('uncertain_failed');
    // RED LINE: zero upstream traffic — no query (nothing to query by) and
    // categorically no re-submit.
    expect(h.http.requests).toHaveLength(0);
    expect(h.settleStore.fails).toHaveLength(1);
    expect(h.settleStore.fails[0]).toMatchObject({
      holdAmount: 5_000n,
      error: expect.objectContaining({ code: 'upstream_timeout' }),
    });
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('failed');
  });

  it('a taken-over row WITH a handle resumes polling directly (先落库 row = submit proof)', async () => {
    // Called AFTER a claim in the sweep — the lease is already ours (node-A).
    const task = recoveryTask({ ownerNode: 'node-A' });
    const h = harness({ tasks: [task], http: { responses: [{ status: 200, body: SUCCEEDED }] } });
    const outcome = await recoverClaimedTask(h.deps, task);
    expect(outcome.kind).toBe('settled');
    expect(h.http.requests.map((r) => new URL(r.url).pathname)).toEqual(['/mock/tasks/up-1']);
  });

  it('a hold already expired at takeover fails immediately (no poll, no charge)', async () => {
    const task = recoveryTask({ holdExpiresAt: new Date(NOW.getTime() - 1_000) });
    const h = harness({ tasks: [task] });
    const outcome = await recoverClaimedTask(h.deps, task);
    expect(outcome.kind).toBe('expired_hold');
    expect(h.http.requests).toHaveLength(0);
    expect(h.settleStore.fails).toHaveLength(1);
  });
});

// --- §3 direct orphans + §7.3 expired holds -----------------------------------------

describe('reapers — §3 至多一次 / §7.3 backstop', () => {
  it('direct orphan → failed WITHOUT charge, zero upstream calls, never taken over', async () => {
    const orphan = recoveryTask({
      fetchMode: 'direct',
      upstreamTaskId: null,
      ownerNode: null,
      leaseUntil: null,
      holdExpiresAt: new Date(NOW.getTime() - 1),
    });
    const h = harness({ tasks: [orphan] });

    const summary = await reapOrphanedDirectTasks(h.deps, new Date(h.clock.t));

    expect(summary).toEqual({ scanned: 1, failed: 1 });
    expect(h.http.requests).toHaveLength(0); // §3: no re-submit surface at all
    expect(h.settleStore.settles).toHaveLength(0); // 不扣费
    expect(h.settleStore.fails[0]).toMatchObject({
      taskId: orphan.id,
      holdAmount: 5_000n,
      error: expect.objectContaining({ code: 'task_failed' }),
    });
    expect(h.taskStore.tasks.get(orphan.id)?.status).toBe('failed');
    expect(h.emitted).toEqual([{ taskId: orphan.id, type: 'task.failed' }]);
  });

  it('a direct orphan still within its hold window is NOT reaped (kill 场景由 hold 界定)', async () => {
    const inflight = recoveryTask({
      fetchMode: 'direct',
      upstreamTaskId: null,
      holdExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    const h = harness({ tasks: [inflight] });
    const summary = await reapOrphanedDirectTasks(h.deps, new Date(h.clock.t));
    expect(summary).toEqual({ scanned: 0, failed: 0 });
    expect(h.taskStore.tasks.get(inflight.id)?.status).toBe('running');
  });

  it('non-direct expired-hold rows fail via the §7.3 backstop (pending crash orphan included)', async () => {
    const stuckPending = recoveryTask({
      status: 'pending',
      upstreamTaskId: null,
      holdExpiresAt: new Date(NOW.getTime() - 1),
    });
    const h = harness({ tasks: [stuckPending] });
    const summary = await reapExpiredHoldGatewayTasks(h.deps, new Date(h.clock.t));
    expect(summary).toEqual({ scanned: 1, failed: 1 });
    expect(h.settleStore.fails[0]).toMatchObject({
      error: expect.objectContaining({ code: 'upstream_timeout' }),
    });
  });
});

// --- §3 双保险: callback + poll double write ------------------------------------------

describe('applyTaskUpdate — §3 双保险 from-guard convergence', () => {
  const succeededUpdate: TaskUpdate = {
    upstreamTaskId: 'up-1',
    status: 'succeeded',
    output: { url: 'https://cdn.example/v.mp4' },
    usage: { metrics: { seconds: 6 }, billingDims: {}, estimated: false },
  };

  function applyDeps(h: RecoveryHarness): Parameters<typeof applyTaskUpdate>[0] {
    return {
      db: POISONED_DB,
      settleRepo: h.settleStore.repo,
      transitionTask: h.taskStore.repo.transitionTask,
      emitTaskWebhook: h.deps.emitTaskWebhook,
    };
  }

  it('callback fast path settles once; the racing poll write folds to stale (ONE settle, ONE envelope)', async () => {
    const task = recoveryTask();
    const h = harness({ tasks: [task] });

    const first = await applyTaskUpdate(applyDeps(h), task, succeededUpdate, 'callback');
    const second = await applyTaskUpdate(applyDeps(h), task, succeededUpdate, 'poll');

    expect(first.kind).toBe('settled');
    expect(second.kind).toBe('stale');
    // Both attempts reached the settle repo, but the from-guard let exactly
    // ONE move money — and only the winner emitted the §7.6 envelope.
    expect(h.settleStore.settles).toHaveLength(2);
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('succeeded');
    expect(h.emitted).toEqual([{ taskId: task.id, type: 'task.succeeded' }]);
  });

  it('乱序容忍: an in-flight observation NEVER fails the task; on a terminal row it no-ops', async () => {
    const task = recoveryTask();
    const h = harness({ tasks: [task] });
    // Terminalize first (the callback fast path won)…
    await applyTaskUpdate(applyDeps(h), task, succeededUpdate, 'callback');
    // …then a LATE out-of-order running/progress observation arrives.
    const late = await applyTaskUpdate(
      applyDeps(h),
      task,
      { upstreamTaskId: 'up-1', status: 'running', progress: 55 },
      'poll',
    );
    expect(late.kind).toBe('stale');
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('succeeded'); // untouched
    expect(h.settleStore.fails).toHaveLength(0);
  });

  it('an upstream canceled update folds to canceled (hold released, no charge)', async () => {
    const task = recoveryTask();
    const h = harness({ tasks: [task] });
    const outcome = await applyTaskUpdate(
      applyDeps(h),
      task,
      { upstreamTaskId: 'up-1', status: 'canceled' },
      'poll',
    );
    expect(outcome.kind).toBe('canceled');
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('canceled');
    expect(h.settleStore.settles).toHaveLength(0);
    expect(h.emitted).toEqual([{ taskId: task.id, type: 'task.canceled' }]);
  });

  it('a same-value progress re-observation is a noop (no event spam)', async () => {
    const task = recoveryTask({ progress: 40 });
    const h = harness({ tasks: [task] });
    const outcome = await applyTaskUpdate(
      applyDeps(h),
      task,
      { upstreamTaskId: 'up-1', status: 'running', progress: 40 },
      'poll',
    );
    expect(outcome.kind).toBe('noop');
    expect(h.taskStore.events).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });
});

// --- FIX6: §9.2 hold 不免费 — a null holdAmount can never 0-cap a settle -----------------

describe('reconstructSettleBase — FIX6 holdAmount null 守卫 (§9.2 绝不免费出货)', () => {
  it('holdAmount=null succeeded recovery NEVER settles (no 0-capped free debit) — fails without charge', async () => {
    // Called AFTER a claim in the sweep — the lease is already ours (node-A).
    const task = recoveryTask({ holdAmount: null, ownerNode: 'node-A' });
    const h = harness({ tasks: [task], http: { responses: [{ status: 200, body: SUCCEEDED }] } });

    const outcome = await recoverClaimedTask(h.deps, task);

    expect(outcome.kind).toBe('failed');
    // RED LINE: zero settle attempts — before the fix this settled with a 0n
    // cap (free goods / 漏收); now the anomaly fails terminally, no charge.
    expect(h.settleStore.settles).toHaveLength(0);
    expect(h.settleStore.fails).toHaveLength(1);
    expect(h.settleStore.fails[0]).toMatchObject({
      error: expect.objectContaining({
        code: 'internal_error',
        message: expect.stringContaining('no hold amount'),
      }),
    });
    expect(h.taskStore.tasks.get(task.id)?.status).toBe('failed');
    expect(h.emitted).toEqual([{ taskId: task.id, type: 'task.failed' }]);
  });

  it('reconstructSettleBase: null holdAmount → undefined; real 0n hold passes through', () => {
    expect(reconstructSettleBase(recoveryTask({ holdAmount: null }))).toBeUndefined();
    expect(reconstructSettleBase(recoveryTask({ accountId: null }))).toBeUndefined();
    const zeroHold = reconstructSettleBase(recoveryTask({ holdAmount: 0n }));
    expect(zeroHold?.holdAmount).toBe(0n); // a legitimately free admission is untouched
    const normal = reconstructSettleBase(recoveryTask());
    expect(normal?.holdAmount).toBe(5_000n);
  });

  it('a normal holdAmount still settles exactly as before (regression guard)', async () => {
    const task = recoveryTask({ ownerNode: 'node-A' });
    const h = harness({ tasks: [task], http: { responses: [{ status: 200, body: SUCCEEDED }] } });
    const outcome = await recoverClaimedTask(h.deps, task);
    expect(outcome.kind).toBe('settled');
    expect(h.settleStore.settles).toHaveLength(1);
    expect(h.settleStore.settles[0]).toMatchObject({ holdAmount: 5_000n });
    expect(h.settleStore.fails).toHaveLength(0);
  });
});
