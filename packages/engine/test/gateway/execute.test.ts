// 批次4 slice2 — executeGateway dispatch-matrix red lines (§3/§5/§7.3/§7.4/
// §7.8/§9.2), locked over a fake plan + the REAL SPI pipeline (mock dialect +
// fake HttpClient) + in-memory task/settle repos. No live db (POISONED_DB).
import { describe, expect, it } from 'vitest';

import { executeGateway } from '../../src/index.js';
import {
  fakePlan,
  gatewayRequest,
  harness,
  modelOp,
  modelRow,
  NOW,
  taskRowOf,
} from './gateway-fixtures.js';

const OPTS = { accountId: 'acct-1' };

// --- §5 幂等前置 ---------------------------------------------------------------

describe('executeGateway §5 idempotency (BEFORE planning)', () => {
  const idem = { key: 'idem-1', bodyFingerprint: 'fp-aaa' };

  it('same key + DIFFERENT body → 409 conflict; the planner never runs, nothing is held or created', async () => {
    const h = harness({ plan: fakePlan().plan });
    h.taskStore.tasks.set(
      't-existing',
      taskRowOf({ id: 't-existing', idempotencyKey: 'idem-1', requestFingerprint: 'fp-OTHER' }),
    );

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ idempotency: { key: 'idem-1', bodyFingerprint: 'fp-aaa' } }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('conflict');
    expect(h.planLog).toEqual([]); // §5 前置: planning (and its hold) never happened
    expect(h.log.filter((e) => e === 'createTask')).toEqual([]);
    expect(h.settleStore.settles).toEqual([]);
  });

  it('same key + same body → replays the recorded task; the planner never runs (no double charge)', async () => {
    const h = harness({ plan: fakePlan().plan });
    const existing = taskRowOf({
      id: 't-replay',
      status: 'succeeded',
      idempotencyKey: 'idem-1',
      requestFingerprint: 'fp-aaa',
    });
    h.taskStore.tasks.set(existing.id, existing);

    const res = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);

    expect(res.kind).toBe('replay');
    if (res.kind === 'replay') expect(res.task.id).toBe('t-replay');
    expect(h.planLog).toEqual([]);
    expect(h.settleStore.settles).toEqual([]);
  });

  it('createTask backstop race (claim said free, insert lost): reservation fully released, replay/conflict by fingerprint', async () => {
    const { plan, log } = fakePlan({ paradigm: 'task', mode: 'submit_poll' });
    const h = harness({ plan });
    const winner = taskRowOf({
      id: 't-winner',
      idempotencyKey: 'idem-1',
      requestFingerprint: 'fp-aaa',
      status: 'running',
    });
    // Claim answers "free" (the race window) but the winner's row is already
    // in the store — createTask's conflict target resolves it.
    h.taskStore.tasks.set(winner.id, winner);
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      claimTaskIdempotency: () => Promise.resolve({ claimed: true }),
    };

    const res = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);

    expect(res.kind).toBe('replay');
    if (res.kind === 'replay') expect(res.task.id).toBe('t-winner');
    // the loser's reservation must not leak its hold or slot
    expect(log).toContain('release:full');
  });
});

// --- sync × direct ---------------------------------------------------------------

describe('executeGateway sync×direct (§3 matrix row 1)', () => {
  it('正路: plan → runSync → settle; GatewayResponse carries billingDims + servedBy; slot-only release', async () => {
    const { plan, log } = fakePlan({
      billingDims: { resolution: '720p' },
      effective: { canonical: { resolution: '720p' }, upstream: { size: '1280x720' } },
    });
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { ok: true, output: { text: 'hello' }, metrics: { requests: 1 } } },
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('sync');
    if (res.kind !== 'sync') return;
    expect(res.response.output).toEqual({ text: 'hello' });
    expect(res.response.usage.billingDims).toEqual({ resolution: '720p' }); // §4.1 canonical 生效值
    expect(res.response.usage.estimated).toBe(false);
    expect(res.response.servedBy).toMatchObject({
      offeringId: 'off-1',
      channelId: 'chan-1',
      provider: 'mockbrand',
      upstreamModelName: 'up-off-1',
    });
    // §7.8: hold 转 settle — the SLOT alone released, never the full rollback
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
    // settle happened once, over the reservation's snapshot refs
    expect(h.settleStore.settles).toHaveLength(1);
    const settle = h.settleStore.settles[0];
    expect(settle).toMatchObject({
      finalCost: 5_000n,
      holdAmount: 5_000n,
      saleCardRef: { card_id: 'card-sale', version: 3 },
      costCardRef: { card_id: 'card-cost', version: 1 },
      estimated: false,
    });
    // wire order: plan → upstream → settle
    expect(h.log.indexOf('plan')).toBeLessThan(h.log.indexOf('http:/mock/run'));
    expect(h.log.indexOf('http:/mock/run')).toBeLessThan(h.log.indexOf('settle'));
    // §6-③: the mock credential was injected as the bearer header
    expect(h.http.requests[0]?.headers?.authorization).toBe('Bearer sk-mock-1234');
  });

  it('P5b: the settle carries the usage_log/limit-accrual attribution — request.model + apiKeyId + options.routeTag, provider_cost = cost side', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ subjectId: 'subj-1', options: { routeTag: 'canary' } }),
      OPTS,
    );

    expect(res.kind).toBe('sync');
    expect(h.settleStore.settles[0]?.usageLog).toEqual({
      model: 'test-model', // request.model — the EXTERNAL name, not the upstream pin
      apiKeyId: 'key-1',
      providerCost: 1_000n, // §9.2 cost side (card-cost fixed 1000µ), NOT the sale charge
      routeTag: 'canary',
    });
    expect(h.settleStore.settles[0]?.subjectId).toBe('subj-1');
  });

  it('失败: upstream 500 → reservation.release() (hold rollback + slot), error passthrough, ZERO settle', async () => {
    const { plan, log } = fakePlan();
    const h = harness({ plan, http: { responses: [{ status: 500, body: { msg: 'boom' } }] } });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('upstream_error');
    expect(log).toContain('release:full'); // §7.8 失败即释放信号量并回滚 hold
    expect(h.settleStore.settles).toEqual([]);
    expect(h.settleStore.fails).toEqual([]); // no task row on the sync path
  });

  it('plan failure passes through VERBATIM (no dispatch, no release of anything)', async () => {
    const h = harness({
      planError: {
        code: 'insufficient_credits',
        message: 'no',
        retryable: false,
        failover: false,
      },
    });
    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('insufficient_credits');
    expect(h.http.requests).toEqual([]);
  });
});

// --- BUG2 回归: §5 幂等对 sync/stream 也持久化 --------------------------------------

describe('executeGateway §5 idempotency persistence for sync/stream (BUG2)', () => {
  const idem = { key: 'idem-sync', bodyFingerprint: 'fp-1' };
  const okHttp = {
    responses: [
      { status: 200, body: { ok: true, output: { text: 'hi' }, metrics: { requests: 1 } } },
    ],
  };

  it('sync 带幂等键: durable claim row BEFORE dispatch; settle stamps it succeeded with the output (replay target)', async () => {
    const { plan, log } = fakePlan();
    const h = harness({ plan, http: okHttp });

    const res = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);

    expect(res.kind).toBe('sync');
    const rows = [...h.taskStore.tasks.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'succeeded',
      idempotencyKey: 'idem-sync',
      requestFingerprint: 'fp-1',
      fetchMode: 'direct',
      holdAmount: 5_000n,
      accountId: 'acct-1',
      output: { text: 'hi' },
    });
    // the claim row is durable BEFORE the upstream call (§7.4 analog)
    expect(h.log.indexOf('createTask')).toBeGreaterThan(-1);
    expect(h.log.indexOf('createTask')).toBeLessThan(h.log.indexOf('http:/mock/run'));
    // settle rode the task row (transition dedup 生效)
    expect(h.settleStore.settles).toHaveLength(1);
    expect(h.settleStore.settles[0]?.taskId).toBe(rows[0]?.id);
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });

  it('sync 重发同键同体 → replay: no second charge, no second upstream call, no second plan', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan, http: okHttp });

    const first = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);
    expect(first.kind).toBe('sync');

    const replay = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.task.status).toBe('succeeded');
      expect(replay.task.output).toEqual({ text: 'hi' });
    }
    expect(h.planLog).toHaveLength(1); // §5 前置: replay never re-plans (no re-hold)
    expect(h.http.requests).toHaveLength(1); // never re-hits the upstream
    expect(h.settleStore.settles).toHaveLength(1); // charged exactly once
  });

  it('sync 同键不同体 → 409 conflict, nothing dispatched twice', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan, http: okHttp });

    const first = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);
    expect(first.kind).toBe('sync');

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ idempotency: { key: 'idem-sync', bodyFingerprint: 'fp-OTHER' } }),
      OPTS,
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('conflict');
    expect(h.http.requests).toHaveLength(1);
    expect(h.settleStore.settles).toHaveLength(1);
  });

  it('并发同键 (claim raced, createTask backstop): loser releases FULLY, winner row replays — 仅一次扣费', async () => {
    const { plan, log } = fakePlan();
    const h = harness({ plan, http: okHttp });
    const winner = taskRowOf({
      id: 't-winner-sync',
      idempotencyKey: 'idem-sync',
      requestFingerprint: 'fp-1',
      status: 'running',
    });
    h.taskStore.tasks.set(winner.id, winner);
    // the race window: the pre-check claim answers "free"
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      claimTaskIdempotency: () => Promise.resolve({ claimed: true }),
    };

    const res = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);

    expect(res.kind).toBe('replay');
    if (res.kind === 'replay') expect(res.task.id).toBe('t-winner-sync');
    expect(log).toContain('release:full'); // the loser's hold+slot rolled back
    expect(h.settleStore.settles).toEqual([]); // the loser never charged
    expect(h.http.requests).toEqual([]); // and never hit the upstream
  });

  it('无幂等键 sync 保持轻量: no task row is created', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan, http: okHttp });
    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('sync');
    expect(h.taskStore.tasks.size).toBe(0);
    expect(h.log.filter((e) => e === 'createTask')).toEqual([]);
  });

  it('stream 带幂等键: row created before the open; drain settles it → succeeded', async () => {
    const { plan } = fakePlan({ paradigm: 'stream', mode: 'stream' });
    const usage = { metrics: { output_tokens: 7 }, billingDims: {}, estimated: false };
    const h = harness({
      plan,
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'x' }),
          JSON.stringify({ kind: 'done', usage }),
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest({ idempotency: idem }), OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') return;
    for await (const frame of res.frames) void frame;

    const rows = [...h.taskStore.tasks.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('succeeded');
    expect(h.settleStore.settles).toHaveLength(1);
    expect(h.settleStore.settles[0]?.taskId).toBe(rows[0]?.id);
  });
});

// --- BUG3 回归: §3 fetch 分派矩阵补全 --------------------------------------------------

describe('executeGateway sync×stream (§3 drain-assemble)', () => {
  it('drains ALL frames and assembles a complete sync response (chat text 拼接 + usage 帧); settle 一次', async () => {
    const { plan, log } = fakePlan({ paradigm: 'sync', mode: 'stream' });
    const usage = { metrics: { output_tokens: 42 }, billingDims: {}, estimated: false };
    const h = harness({
      plan,
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'he' }),
          JSON.stringify({ kind: 'delta', text: 'llo' }),
          JSON.stringify({ kind: 'done', usage }),
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('sync');
    if (res.kind !== 'sync') return;
    expect(res.response.output).toEqual({ text: 'hello' }); // 完整组装, not a fragment
    expect(res.response.usage.metrics).toEqual({ output_tokens: 42 });
    expect(res.response.servedBy.offeringId).toBe('off-1');
    expect(h.settleStore.settles).toHaveLength(1);
    expect(h.settleStore.settles[0]?.usage?.metrics).toEqual({ output_tokens: 42 });
    // hold 转 settle: slot only
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });

  it('open failure (首帧前) → dispatch failure: hold rolled back, no settle, error (无兄弟候选 → 最终错)', async () => {
    const { plan, log } = fakePlan({ paradigm: 'sync', mode: 'stream' });
    const h = harness({ plan, http: { streamStatus: 500 } });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('upstream_error');
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });

  it('mid-drain error frame → no charge (nothing was delivered downstream), hold rolled back', async () => {
    const { plan, log } = fakePlan({ paradigm: 'sync', mode: 'stream' });
    const h = harness({
      plan,
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'partial' }),
          JSON.stringify({ kind: 'error', message: 'died mid-drain' }),
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    expect(h.settleStore.settles).toEqual([]);
    expect(log).toContain('release:full');
  });
});

describe('executeGateway stream×direct (§3 优雅降级)', () => {
  it('single-shot result wrapped as delta+done stream; settled EXACTLY once (eagerly)', async () => {
    const { plan, log } = fakePlan({ paradigm: 'stream', mode: 'direct' });
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { ok: true, output: { text: 'hi' }, metrics: { requests: 1 } } },
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('stream'); // NOT a 500 — the drop-in chat config serves
    if (res.kind !== 'stream') return;
    expect(res.firstFrame).toEqual({ kind: 'delta', payload: { text: 'hi' } });

    const frames = [];
    for await (const frame of res.frames) frames.push(frame);
    expect(frames.map((f) => f.kind)).toEqual(['delta', 'done']);
    const done = frames[1];
    if (done?.kind === 'done') {
      expect(done.usage?.metrics).toEqual({ requests: 1 });
      expect(done.servedBy?.offeringId).toBe('off-1');
    }

    expect(h.settleStore.settles).toHaveLength(1); // exactly once, eager
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });

  it('upstream failure → error + full release, zero settle (never a silent empty stream)', async () => {
    const { plan, log } = fakePlan({ paradigm: 'stream', mode: 'direct' });
    const h = harness({ plan, http: { responses: [{ status: 500, body: { msg: 'x' } }] } });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });
});

describe('executeGateway sync×submit_poll (§3 block-poll 择稳)', () => {
  const pollPlan = (maxRun?: number): ReturnType<typeof fakePlan> =>
    fakePlan({
      paradigm: 'sync',
      mode: 'submit_poll',
      model: modelRow({ maxRunTimeSeconds: maxRun ?? 600 }),
    });

  it('submit → poll(running) → poll(succeeded) → assembled sync response, settle 一次', async () => {
    const { plan, log } = pollPlan();
    const usage = { metrics: { images: 1 }, billingDims: {}, estimated: false };
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-9' } },
          { status: 200, body: { taskId: 'up-9', status: 'running' } },
          {
            status: 200,
            body: { taskId: 'up-9', status: 'succeeded', output: { url: 'x' }, usage },
          },
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('sync'); // NOT a 500
    if (res.kind !== 'sync') return;
    expect(res.response.output).toEqual({ url: 'x' });
    expect(res.response.usage.metrics).toEqual({ images: 1 });
    // submit + 2 polls, in order
    expect(h.http.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/mock/submit',
      '/mock/tasks/up-9',
      '/mock/tasks/up-9',
    ]);
    expect(h.settleStore.settles).toHaveLength(1);
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });

  it('poll 单次失败不一错即败: a 500 poll is tolerated, the next terminal poll serves', async () => {
    const { plan } = pollPlan();
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-9' } },
          { status: 500, body: { msg: 'blip' } },
          { status: 200, body: { taskId: 'up-9', status: 'succeeded', output: { url: 'y' } } },
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('sync');
    if (res.kind !== 'sync') return;
    expect(res.response.output).toEqual({ url: 'y' });
    expect(h.settleStore.settles).toHaveLength(1);
  });

  it('上游终态 failed → error, hold rolled back, ZERO settle', async () => {
    const { plan, log } = pollPlan();
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-9' } },
          { status: 200, body: { taskId: 'up-9', status: 'failed' } },
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('task_failed');
    expect(h.settleStore.settles).toEqual([]);
    expect(log).toContain('release:full');
  });

  it('poll budget exhausted → upstream_timeout{failover:false}, no charge, no reroute', async () => {
    const { plan } = pollPlan(2); // 2s budget → 2 poll attempts under the frozen clock
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-9' } },
          { status: 200, body: { taskId: 'up-9', status: 'running' } },
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('upstream_timeout');
      expect(res.error.failover).toBe(false);
    }
    expect(h.planLog).toHaveLength(1); // never rerouted to a sibling
    expect(h.settleStore.settles).toEqual([]);
  });

  it('带幂等键: the row records the upstream handle mid-poll and lands succeeded', async () => {
    const { plan } = pollPlan();
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-9' } },
          { status: 200, body: { taskId: 'up-9', status: 'succeeded', output: { url: 'z' } } },
        ],
      },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ idempotency: { key: 'k-poll', bodyFingerprint: 'fp-p' } }),
      OPTS,
    );
    expect(res.kind).toBe('sync');
    const row = [...h.taskStore.tasks.values()][0];
    expect(row).toMatchObject({
      status: 'succeeded',
      upstreamTaskId: 'up-9',
      fetchMode: 'submit_poll',
      ownerNode: 'gateway', // recoverable mode → leased for slice4 takeover
    });
  });
});

// --- FIX4: §7.2 in-request 周期续租 (block-poll budgets > the lease horizon) -----------------

describe('executeGateway sync×submit_poll — FIX4 §7.2 in-request lease renewal', () => {
  /** An advancing-clock harness: sleep moves simulated time, 30s poll cadence. */
  function leaseHarness(responses: { status: number; body: unknown }[]): {
    h: ReturnType<typeof harness>;
    clock: { t: number };
    renews: { at: number; leaseUntil: number }[];
  } {
    const { plan } = fakePlan({
      paradigm: 'sync',
      mode: 'submit_poll',
      model: modelRow({ maxRunTimeSeconds: 180 }), // budget 180s ≫ 60s lease horizon
    });
    const clock = { t: NOW.getTime() };
    const h = harness({ plan, http: { responses } });
    h.deps.now = () => new Date(clock.t);
    h.deps.nowMs = () => clock.t;
    h.deps.sleep = (ms: number): Promise<void> => {
      clock.t += Math.max(ms, 1);
      return Promise.resolve();
    };
    h.deps.syncPollIntervalMs = 30_000;

    const renews: { at: number; leaseUntil: number }[] = [];
    const baseRenew = h.taskStore.repo.renewTaskLease;
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      renewTaskLease: (db, taskId, ownerNode, leaseUntil) => {
        renews.push({ at: clock.t, leaseUntil: leaseUntil.getTime() });
        return baseRenew(db, taskId, ownerNode, leaseUntil);
      },
    };
    return { h, clock, renews };
  }

  const IDEM = { idempotency: { key: 'k-lease', bodyFingerprint: 'fp-lease' } };

  it('renews before EVERY probe — the lease NEVER lapses, so the takeover sweep sees nothing', async () => {
    // submit → running ×3 (t=0s/30s/60s) → succeeded (t=90s): the poll window
    // crosses the 60s lease horizon, which un-renewed would hand the row to
    // the sweep mid-poll (double poll + double persist).
    const { h, renews } = leaseHarness([
      { status: 200, body: { taskId: 'up-9' } },
      { status: 200, body: { taskId: 'up-9', status: 'running' } },
      { status: 200, body: { taskId: 'up-9', status: 'running' } },
      { status: 200, body: { taskId: 'up-9', status: 'running' } },
      { status: 200, body: { taskId: 'up-9', status: 'succeeded', output: { url: 'ok' } } },
    ]);

    const res = await executeGateway(h.deps, gatewayRequest(IDEM), OPTS);

    expect(res.kind).toBe('sync');
    expect(renews.length).toBeGreaterThanOrEqual(3); // one renew per probe
    // The sweep's takeover predicate is `lease_until < now`: at every renewal
    // instant the PREVIOUS lease must still be live — never once expired.
    for (let i = 1; i < renews.length; i++) {
      expect(renews[i]?.at ?? Number.POSITIVE_INFINITY).toBeLessThan(
        renews[i - 1]?.leaseUntil ?? 0,
      );
    }
    // And every renewal pushed the horizon a full lease ahead of its instant.
    for (const r of renews) expect(r.leaseUntil - r.at).toBe(60_000);
    expect(h.settleStore.settles).toHaveLength(1); // settled exactly once, by US
  });

  it('a LOST lease stops the block-poll instantly: no further probe, no settle, no §8 reroute', async () => {
    const { h } = leaseHarness([
      { status: 200, body: { taskId: 'up-9' } },
      { status: 200, body: { taskId: 'up-9', status: 'running' } },
    ]);
    // First renew succeeds; every later renew reports the lease stolen.
    const baseRenew = h.taskStore.repo.renewTaskLease;
    let renewCalls = 0;
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      renewTaskLease: (db, taskId, ownerNode, leaseUntil) => {
        renewCalls += 1;
        if (renewCalls >= 2) return Promise.resolve(false);
        return baseRenew(db, taskId, ownerNode, leaseUntil);
      },
    };

    const res = await executeGateway(h.deps, gatewayRequest(IDEM), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.message).toContain('lease');
      expect(res.error.failover).toBe(false); // 失主让位 — never re-run elsewhere
    }
    // §7.2 失主立即停手: submit + exactly ONE probe — the failed renew blocked
    // the second probe before any upstream call.
    expect(h.http.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/mock/submit',
      '/mock/tasks/up-9',
    ]);
    expect(h.planLog).toHaveLength(1); // no failover reroute
    expect(h.settleStore.settles).toEqual([]); // and nothing was charged
  });
});

// --- BUG4 回归: §8 failover 循环 -----------------------------------------------------

describe('executeGateway §8 failover loop', () => {
  /** Two-offering planner: hop 0 → A; hop 1 (A excluded) → B; then exhausted. */
  function twoOfferingDeps(o: {
    paradigm?: 'sync' | 'task';
    mode?: 'direct' | 'submit_poll';
    responses: { status: number; body: unknown }[];
  }): {
    h: ReturnType<typeof harness>;
    logA: string[];
    logB: string[];
    planInputs: (readonly string[] | undefined)[];
  } {
    const paradigm = o.paradigm ?? 'sync';
    const mode = o.mode ?? 'direct';
    const a = fakePlan({ paradigm, mode, offeringId: 'off-A', channelId: 'chan-A' });
    const b = fakePlan({ paradigm, mode, offeringId: 'off-B', channelId: 'chan-B' });
    const planInputs: (readonly string[] | undefined)[] = [];
    const h = harness({ plan: a.plan, http: { responses: o.responses } });
    h.deps.planner = (_deps, input) => {
      planInputs.push(input.excludeOfferingIds);
      if (input.excludeOfferingIds === undefined) return Promise.resolve(a.plan);
      if (input.excludeOfferingIds.includes('off-B')) {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'upstream_error',
            message: 'no routable supply offering',
            retryable: true,
            failover: false,
          },
          warnings: [],
          trace: { rejected: [], attempts: [] },
        });
      }
      return Promise.resolve(b.plan);
    };
    return { h, logA: a.log, logB: b.log, planInputs };
  }

  it('A upstream_error{failover:true} → release A 的 hold → 重规划排除 A → B 成功', async () => {
    const { h, logA, logB, planInputs } = twoOfferingDeps({
      responses: [
        { status: 500, body: { msg: 'A boom' } },
        { status: 200, body: { ok: true, output: { text: 'via-B' }, metrics: { requests: 1 } } },
      ],
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('sync');
    if (res.kind !== 'sync') return;
    expect(res.response.output).toEqual({ text: 'via-B' });
    expect(res.response.servedBy.offeringId).toBe('off-B');
    // A 的 hold 回滚 (release:full); B 只释放 slot (hold 转 settle)
    expect(logA).toContain('release:full');
    expect(logB).toContain('release:slot');
    expect(logB).not.toContain('release:full');
    // 重规划确实排除了 A
    expect(planInputs[0]).toBeUndefined();
    expect(planInputs[1]).toEqual(['off-A']);
    // 只结算一次 (B)
    expect(h.settleStore.settles).toHaveLength(1);
  });

  it('候选耗尽 → 返回最后一次 dispatch 错误 (不是笼统 no-supply)', async () => {
    const { plan, log } = fakePlan();
    const h = harness({ plan, http: { responses: [{ status: 500, body: { msg: 'boom' } }] } });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('upstream_error');
      expect(res.error.message).toContain('500'); // A 的真实 dispatch 错误
    }
    expect(h.planLog).toHaveLength(2); // 尝试重规划过一次(排除后无候选)
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });

  it('failover=false 的错误 (如 4xx invalid) 不触发循环', async () => {
    const { plan, log } = fakePlan();
    // mock dialect: 400 → upstream_error{failover:false}
    const h = harness({ plan, http: { responses: [{ status: 400, body: { msg: 'bad' } }] } });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    expect(h.planLog).toHaveLength(1); // never re-planned
    expect(h.http.requests).toHaveLength(1);
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });

  it('跳数上限 maxFailoverHops 生效: 到顶后返回最后错误并完全回滚', async () => {
    const plans = [
      fakePlan({ offeringId: 'off-1' }),
      fakePlan({ offeringId: 'off-2' }),
      fakePlan({ offeringId: 'off-3' }),
    ];
    const h = harness({
      plan: plans[0]?.plan,
      http: { responses: [{ status: 500, body: { msg: 'always down' } }] },
    });
    let call = 0;
    h.deps.planner = () => {
      const p = plans[Math.min(call, plans.length - 1)];
      call += 1;
      if (p === undefined) throw new Error('unreachable');
      return Promise.resolve(p.plan);
    };
    h.deps.maxFailoverHops = 1;

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    expect(call).toBe(2); // 1 + 1 extra hop, never a third
    expect(h.http.requests).toHaveLength(2);
    expect(plans[0]?.log).toContain('release:full');
    expect(plans[1]?.log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });

  it('task×submit failover: submit A 失败 → 同一 task 行重绑 B → B submit 成功 202 (单行,不重复建行)', async () => {
    const { h, logA, logB } = twoOfferingDeps({
      paradigm: 'task',
      mode: 'submit_poll',
      responses: [
        { status: 500, body: { msg: 'A submit down' } },
        { status: 200, body: { taskId: 'up-B' } },
      ],
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;
    expect(res.status).toBe(202);
    expect(res.task.upstreamTaskId).toBe('up-B');
    expect(res.task.offeringId).toBe('off-B'); // re-bound, not re-created
    expect(res.task.holdAmount).toBe(5_000n); // B 的 hold 重新盖章
    expect(h.taskStore.tasks.size).toBe(1); // ONE row across both hops
    expect(logA).toContain('release:full'); // A 的 hold 回滚
    expect(logB).toContain('release:slot');
    expect(logB).not.toContain('release:full'); // B 的 hold rides the task
    // the reroute trail is on the events
    const substates = h.taskStore.events.map((e) => e.payload);
    expect(JSON.stringify(substates)).toContain('failover');
  });

  it('task×submit 候选耗尽: row → failed with holdAmount 0 (hold 已回滚,reaper 无双放目标), 不扣费', async () => {
    const { plan, log } = fakePlan({ paradigm: 'task', mode: 'submit_poll' });
    const h = harness({
      plan,
      http: { responses: [{ status: 500, body: { msg: 'down' } }] },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    const row = [...h.taskStore.tasks.values()][0];
    expect(row?.status).toBe('failed');
    expect(row?.holdAmount).toBe(0n); // zeroed BEFORE release — reaper can never double-release
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
    expect(h.settleStore.fails).toEqual([]); // no wallet movement on the terminal fail
  });
});

// --- task × submit_poll (§7.4) ------------------------------------------------------

describe('executeGateway task×submit (§7.4 先落库再调上游)', () => {
  const taskPlan = (): ReturnType<typeof fakePlan> =>
    fakePlan({
      paradigm: 'task',
      mode: 'submit_poll',
      model: modelRow({
        operations: [modelOp('video.generation', { paradigms: ['task'] })],
        maxRunTimeSeconds: 600,
      }),
    });

  it('正路: durable task row BEFORE the upstream submit → upstreamTaskId recorded → 202+Task; hold stays, slot freed', async () => {
    const { plan, log } = taskPlan();
    const h = harness({
      plan,
      http: { responses: [{ status: 200, body: { taskId: 'up-123' } }] },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;
    expect(res.status).toBe(202);
    expect(res.run).toBeUndefined(); // only direct carries the runner
    expect(res.task).toMatchObject({
      status: 'running',
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-123',
      internalSubstate: 'upstream_submitted',
      ownerNode: 'gateway', // recoverable mode → leased (§7.2)
      holdAmount: 5_000n,
      accountId: 'acct-1',
    });
    expect(res.task.leaseUntil).toEqual(new Date(NOW.getTime() + 60_000));
    // §7.4 red line: the row is durable BEFORE the upstream call
    expect(h.log.indexOf('createTask')).toBeGreaterThan(-1);
    expect(h.log.indexOf('createTask')).toBeLessThan(h.log.indexOf('http:/mock/submit'));
    // 202 answers WITHOUT settling — poll/settle is the slice4 worker
    expect(h.settleStore.settles).toEqual([]);
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full'); // the hold RIDES the task
    // birth event + transitions recorded
    expect(h.taskStore.events.map((e) => `${e.from ?? '∅'}→${e.to}`)).toEqual([
      '∅→pending',
      'pending→running',
      'running→running',
    ]);
  });

  it('submit 失败: task → failed + reservation.release() (hold rollback), error passthrough', async () => {
    const { plan, log } = taskPlan();
    const h = harness({
      plan,
      http: { responses: [{ status: 500, body: { msg: 'submit exploded' } }] },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('upstream_error');
    const task = [...h.taskStore.tasks.values()][0];
    expect(task?.status).toBe('failed');
    expect(log).toContain('release:full'); // §7.8 hold 回滚
    expect(h.settleStore.settles).toEqual([]); // 不扣费
  });

  it('submit 超时 (uncertain): 宁可 failed — marked submit_uncertain, NEVER re-submitted, no charge (§7.4)', async () => {
    const { plan, log } = taskPlan();
    const h = harness({
      plan,
      http: {
        requestThrows: Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
      },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('upstream_timeout');
    const task = [...h.taskStore.tasks.values()][0];
    expect(task?.status).toBe('failed');
    expect(task?.internalSubstate).toBe('submit_uncertain');
    // exactly ONE upstream call — no blind re-submission
    expect(h.http.requests).toHaveLength(1);
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });

  it('inline submit result (upstream completed synchronously) settles immediately → terminal task', async () => {
    const { plan, log } = taskPlan();
    const h = harness({
      plan,
      http: {
        responses: [
          {
            status: 200,
            body: {
              inline: {
                output: { url: 'https://cdn/x.png' },
                usage: { metrics: { images: 1 }, billingDims: {}, estimated: false },
              },
            },
          },
        ],
      },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;
    expect(res.task.status).toBe('succeeded');
    expect(h.settleStore.settles).toHaveLength(1);
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });
});

// --- §7.3 hold TTL --------------------------------------------------------------------

describe('executeGateway §7.3 hold TTL = min(model, offering) + buffer — NOT 15min', () => {
  it('model 600s × offering 300s → hold_expires_at = now + 300 + 120 buffer', async () => {
    const { plan } = fakePlan({
      paradigm: 'task',
      mode: 'submit_poll',
      model: modelRow({
        operations: [modelOp('video.generation', { paradigms: ['task'] })],
        maxRunTimeSeconds: 600,
      }),
      timeoutBudgetSeconds: 300,
    });
    const h = harness({ plan, http: { responses: [{ status: 200, body: { taskId: 'up-1' } }] } });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;
    expect(res.task.maxRunTimeSeconds).toBe(300); // min(600, 300)
    expect(res.task.holdExpiresAt).toEqual(new Date(NOW.getTime() + (300 + 120) * 1000));
    expect(res.task.holdExpiresAt).not.toEqual(new Date(NOW.getTime() + 15 * 60 * 1000));
  });

  it('neither model nor offering declares a budget → the 3600s default + buffer (still not 15min)', async () => {
    const { plan } = fakePlan({
      paradigm: 'task',
      mode: 'submit_poll',
      model: modelRow({
        operations: [modelOp('video.generation', { paradigms: ['task'] })],
        maxRunTimeSeconds: null,
      }),
    });
    const h = harness({ plan, http: { responses: [{ status: 200, body: { taskId: 'up-1' } }] } });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );
    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;
    expect(res.task.holdExpiresAt).toEqual(new Date(NOW.getTime() + (3_600 + 120) * 1000));
  });
});

// --- task × direct (§3 at-most-once) -----------------------------------------------------

describe('executeGateway task×direct (§3 至多一次)', () => {
  const directPlan = (): ReturnType<typeof fakePlan> =>
    fakePlan({
      paradigm: 'task',
      autoUpgraded: true,
      mode: 'direct',
      model: modelRow({
        operations: [modelOp('images.generation', { paradigms: ['sync'], slow: true })],
        maxRunTimeSeconds: 240,
      }),
    });

  it('202 answers with the at-most-once marker (fetchMode=direct, NEVER leased) and a runner thunk', async () => {
    const { plan } = directPlan();
    const h = harness({ plan });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'images.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;
    expect(res.status).toBe(202);
    expect(res.task.fetchMode).toBe('direct'); // THE at-most-once marker (slice4 recovery keys off it)
    expect(res.task.ownerNode).toBeNull(); // direct is never leased (§7.2)
    expect(res.task.leaseUntil).toBeNull();
    expect(typeof res.run).toBe('function');
    // nothing has gone upstream yet — the runner owns the long-blocking call
    expect(h.http.requests).toEqual([]);
  });

  it('runner failure → failed + hold rollback, NO charge (崩溃/失败平台吸收), no re-submission', async () => {
    const { plan, log } = directPlan();
    const h = harness({ plan, http: { responses: [{ status: 500, body: { msg: 'died' } }] } });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'images.generation' }),
      OPTS,
    );
    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;

    const terminal = await res.run?.();
    expect(terminal?.status).toBe('failed');
    // §3 red line: NO charge — settle never ran; the hold was rolled back
    expect(h.settleStore.settles).toEqual([]);
    expect(log).toContain('release:full');
    // exactly one upstream attempt — at-most-once, no blind retry
    expect(h.http.requests).toHaveLength(1);
  });

  it('runner success → settle → succeeded (charged once)', async () => {
    const { plan, log } = directPlan();
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { ok: true, output: { url: 'x' }, metrics: { images: 1 } } },
        ],
      },
    });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'images.generation' }),
      OPTS,
    );
    expect(res.kind).toBe('task');
    if (res.kind !== 'task') return;

    const terminal = await res.run?.();
    expect(terminal?.status).toBe('succeeded');
    expect(h.settleStore.settles).toHaveLength(1);
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });
});

// --- stream × stream (§3 pre-commit) ------------------------------------------------------

describe('executeGateway stream×stream (§3 pre-commit)', () => {
  const streamPlan = (): ReturnType<typeof fakePlan> =>
    fakePlan({ paradigm: 'stream', mode: 'stream' });

  it('首帧前失败 (open 500) → REAL error (no 200, no stream) + full release', async () => {
    const { plan, log } = streamPlan();
    const h = harness({ plan, http: { streamStatus: 500 } });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('upstream_error');
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });

  it('首帧后: frames replay the first frame, drain settles EXACTLY once with the terminal usage', async () => {
    const { plan, log } = streamPlan();
    const usage = { metrics: { output_tokens: 42 }, billingDims: {}, estimated: false };
    const h = harness({
      plan,
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'he' }),
          JSON.stringify({ kind: 'delta', text: 'llo' }),
          JSON.stringify({ kind: 'done', usage }),
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') return;
    expect(res.firstFrame).toEqual({ kind: 'delta', payload: 'he' });

    const seen: string[] = [];
    for await (const frame of res.frames) seen.push(frame.kind);
    expect(seen).toEqual(['delta', 'delta', 'done']); // first frame REPLAYED, not skipped

    expect(h.settleStore.settles).toHaveLength(1); // settle exactly once, at drain
    expect(h.settleStore.settles[0]?.usage?.metrics).toEqual({ output_tokens: 42 });
    expect(log).toContain('release:slot');
    expect(log).not.toContain('release:full');
  });

  it('mid-stream error frame → forwarded in-band, then fail/release (no charge, 已发帧禁重试)', async () => {
    const { plan, log } = streamPlan();
    const h = harness({
      plan,
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'partial' }),
          JSON.stringify({ kind: 'error', message: 'upstream died mid-stream' }),
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') return;

    const kinds: string[] = [];
    for await (const frame of res.frames) kinds.push(frame.kind);
    expect(kinds).toEqual(['delta', 'error']);

    expect(h.settleStore.settles).toEqual([]); // no charge
    expect(log).toContain('release:full'); // hold rolled back
  });

  it('consumer disconnect (early return) still settles exactly once', async () => {
    const { plan } = streamPlan();
    const h = harness({
      plan,
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'a' }),
          JSON.stringify({ kind: 'delta', text: 'b' }),
          JSON.stringify({ kind: 'done' }),
        ],
      },
    });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);
    expect(res.kind).toBe('stream');
    if (res.kind !== 'stream') return;

    for await (const frame of res.frames) {
      void frame;
      break; // disconnect after the first frame
    }
    expect(h.settleStore.settles).toHaveLength(1); // finally-path settle fired
  });
});

// --- FOUND-1 回归: §3 servability mismatch 只剩防御性断言 -------------------------------

describe('executeGateway §3 servability mismatch — defensive assertion (FOUND-1)', () => {
  it('stream×submit_poll plan (planner/servability drift) → terminal internal_error + full release, ZERO failover spin', async () => {
    const { plan, log } = fakePlan({ paradigm: 'stream', mode: 'submit_poll' });
    const h = harness({ plan });

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.failover).toBe(false);
      expect(res.error.message).toContain('servability');
    }
    expect(h.planLog).toHaveLength(1); // NEVER re-planned — no hold-write/rollback churn
    expect(h.http.requests).toEqual([]); // nothing went upstream
    expect(log).toContain('release:full'); // the hold rolled back exactly once
    expect(h.settleStore.settles).toEqual([]);
  });

  it('task×stream plan (planner/servability drift) → row failed + terminal internal_error, ZERO failover spin', async () => {
    const { plan, log } = fakePlan({ paradigm: 'task', mode: 'stream' });
    const h = harness({ plan });

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.failover).toBe(false);
    }
    const row = [...h.taskStore.tasks.values()][0];
    expect(row?.status).toBe('failed'); // the durable row does not dangle as running
    expect(h.planLog).toHaveLength(1);
    expect(h.http.requests).toEqual([]);
    expect(log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });
});

// --- FOUND-2 回归: failover rebind 清上游痕迹 ------------------------------------------

describe('executeGateway failover rebind clears upstream traces (FOUND-2)', () => {
  it('hop A records handle up-A → failover → rebind to B: upstreamTaskId/progress cleared, A 的迟到回调无从命中', async () => {
    // sync×submit_poll + idempotency key: A submits fine (handle up-A lands on
    // the row), A's poll answers terminal failed{failover:true} → §8 reroute →
    // B's SUBMIT is rejected terminally (400). Without the fix the final row
    // still carries up-A — A's late callback would terminalize it.
    const a = fakePlan({
      paradigm: 'sync',
      mode: 'submit_poll',
      offeringId: 'off-A',
      channelId: 'chan-A',
      model: modelRow({ maxRunTimeSeconds: 600 }),
    });
    const b = fakePlan({
      paradigm: 'sync',
      mode: 'submit_poll',
      offeringId: 'off-B',
      channelId: 'chan-B',
      model: modelRow({ maxRunTimeSeconds: 600 }),
    });
    const h = harness({
      plan: a.plan,
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-A' } },
          {
            status: 200,
            body: {
              taskId: 'up-A',
              status: 'failed',
              error: {
                code: 'upstream_error',
                message: 'A node lost',
                retryable: false,
                failover: true,
              },
            },
          },
          { status: 400, body: { msg: 'B rejected the submit' } },
        ],
      },
    });
    h.deps.planner = (_deps, input) =>
      Promise.resolve(input.excludeOfferingIds === undefined ? a.plan : b.plan);
    // Spy every transition's columns so the rebind's trace-clearing is asserted directly.
    const transitions: { to: string; extra: Record<string, unknown> }[] = [];
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      transitionTask: (db, id, from, to, extra) => {
        transitions.push({ to, extra: { ...(extra ?? {}) } });
        return h.taskStore.repo.transitionTask(db, id, from, to, extra);
      },
    };

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ idempotency: { key: 'k-rebind', bodyFingerprint: 'fp-r' } }),
      OPTS,
    );

    expect(res.kind).toBe('error'); // B's terminal submit rejection answers
    // the row survived BOTH hops as ONE row and no longer names A's handle
    expect(h.taskStore.tasks.size).toBe(1);
    const row = [...h.taskStore.tasks.values()][0];
    expect(row?.status).toBe('failed');
    expect(row?.upstreamTaskId).toBeNull(); // NOT 'up-A' — the leak this regression pins
    expect(row?.progress).toBeNull();
    // A's late callback correlation can no longer find the row by up-A
    await expect(
      h.taskStore.repo.getTaskByUpstreamTaskId(h.deps.db, 'up-A'),
    ).resolves.toBeUndefined();
    // the reroute AND the rebind both cleared the traces explicitly
    const reroute = transitions.find((t) => t.extra.internalSubstate === 'failover_reroute');
    expect(reroute?.extra).toMatchObject({ upstreamTaskId: null, progress: null, holdAmount: 0n });
    const rebind = transitions.find(
      (t) => (t.extra.eventPayload as { failoverRebind?: boolean } | undefined)?.failoverRebind,
    );
    expect(rebind?.extra).toMatchObject({ upstreamTaskId: null, progress: null });
    // both hops rolled back, nothing charged
    expect(a.log).toContain('release:full');
    expect(b.log).toContain('release:full');
    expect(h.settleStore.settles).toEqual([]);
  });
});

// --- FOUND-4 回归: dispatch infra 异常密封 ---------------------------------------------

describe('executeGateway dispatch infra-exception seal (FOUND-4)', () => {
  it('createTask throws mid-dispatch → reservation fully released (hold + slot), internal_error{retryable:true}, nothing upstream', async () => {
    const { plan, log } = fakePlan();
    const h = harness({ plan });
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      createTask: () => Promise.reject(new Error('connection reset by peer')),
    };

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ idempotency: { key: 'k-infra', bodyFingerprint: 'fp-i' } }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.retryable).toBe(true);
      expect(res.error.message).toContain('connection reset');
    }
    expect(log).toContain('release:full'); // §7.8: the hold did NOT leak
    expect(h.http.requests).toEqual([]);
    expect(h.settleStore.settles).toEqual([]);
  });

  it('transitionTask throws after createTask (task paradigm) → reservation released, row failed via the catch, internal_error{retryable:true}', async () => {
    const { plan, log } = fakePlan({ paradigm: 'task', mode: 'submit_poll' });
    const h = harness({ plan });
    let calls = 0;
    h.deps.taskRepo = {
      ...h.taskStore.repo,
      transitionTask: (db, id, from, to, extra) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('task_events seq exhausted'));
        return h.taskStore.repo.transitionTask(db, id, from, to, extra);
      },
    };

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ operation: 'video.generation' }),
      OPTS,
    );

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.retryable).toBe(true);
    }
    const row = [...h.taskStore.tasks.values()][0];
    expect(row?.status).toBe('failed'); // the catch failed the created row
    expect(log).toContain('release:full');
    expect(h.http.requests).toEqual([]); // §7.4: the broken dispatch never reached the upstream
    expect(h.settleStore.settles).toEqual([]);
  });

  it('settle transaction throws AFTER upstream success (keyless sync — no row, no reaper) → reservation released, internal_error{retryable:true}: the hold can never leak permanently', async () => {
    const { plan, log } = fakePlan();
    const h = harness({
      plan,
      http: {
        responses: [
          { status: 200, body: { ok: true, output: { text: 'hi' }, metrics: { requests: 1 } } },
        ],
      },
    });
    h.deps.settleRepo = {
      ...h.settleStore.repo,
      settleGatewayTask: () => Promise.reject(new Error('deadlock detected')),
    };

    const res = await executeGateway(h.deps, gatewayRequest(), OPTS);

    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.error.code).toBe('internal_error');
      expect(res.error.retryable).toBe(true);
      expect(res.error.message).toContain('deadlock');
    }
    expect(log).toContain('release:full'); // keyless path: ONLY the reservation can free this hold
  });
});
