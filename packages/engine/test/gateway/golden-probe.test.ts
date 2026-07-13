// 批次5 slice1 — the GOLDEN PROBE (golden-probe.ts): real-upstream offering
// admission over the REAL SPI pipeline (mock dialect + fake HttpClient),
// POISONED_DB everywhere (thin execution: the probe owns NO task/wallet/
// semaphore surface — its deps cannot even express one). Locks:
//   - chat ping verdicts (pass / reached-but-erroring / unauthorized / raw
//     transport failure) — the connectivity-vs-functional 判据;
//   - §R5 minimal-tier forcing on billing params (server-side, ignores
//     contract defaults) + declarations exercised through the REAL layer-2;
//   - task-path submit → bounded short-poll to the terminal state;
//   - the R5 budget gate: exhausted budget / min interval refuse BEFORE any
//     upstream byte; BYOK skips the platform budget.
import type { CanonicalParam, GatewayError, ModelOperation, Operation } from '@actionow/contracts';
import type { Dialect } from '@actionow/spi';
import { describe, expect, it } from 'vitest';

import type { GoldenProbeDeps, GoldenProbeSubject } from '../../src/index.js';
import { goldenProbe, InMemoryProbeBudget } from '../../src/index.js';
import { credential, NOW } from '../planner/supply-fixtures.js';
import type { FakeHttpScript } from './gateway-fixtures.js';
import { fakeHttp, POISONED_DB, registryWith, stubDialect } from './gateway-fixtures.js';

// --- fixtures -----------------------------------------------------------------------

function chatOp(params: CanonicalParam[] = []): ModelOperation {
  return { operation: 'chat.completions', paradigms: ['sync'], slow: false, params };
}

function videoOp(params: CanonicalParam[]): ModelOperation {
  return { operation: 'video.generation', paradigms: ['task'], slow: false, params };
}

function subject(o: {
  mode?: 'direct' | 'stream' | 'submit_poll' | 'submit_callback';
  operations?: ModelOperation[];
  declarations?: GoldenProbeSubject['offering']['paramDeclarations'];
  tenantId?: string | null;
  timeoutBudgetSeconds?: number | null;
  operation?: Operation;
}): GoldenProbeSubject {
  return {
    offering: {
      id: 'off-1',
      upstreamModelName: 'up-model',
      fetchProfile: { mode: o.mode ?? 'direct' },
      paramDeclarations: o.declarations ?? [],
      timeoutBudgetSeconds: o.timeoutBudgetSeconds ?? null,
    },
    channel: {
      id: 'chan-1',
      dialect: { ref: 'mock.dialect', version: 'v1' },
      baseUrl: 'https://upstream.test',
      region: null,
      proxyRef: null,
      tenantId: o.tenantId ?? null,
    },
    model: { operations: o.operations ?? [chatOp()], maxRunTimeSeconds: null },
    ...(o.operation !== undefined ? { operation: o.operation } : {}),
  };
}

function deps(
  o: {
    http?: FakeHttpScript;
    dialect?: Dialect;
    budget?: InMemoryProbeBudget;
    limits?: { dailyBudgetUsd: number; minIntervalSec: number };
    noCredential?: boolean;
    nowMs?: () => number;
  } = {},
): { deps: GoldenProbeDeps; http: ReturnType<typeof fakeHttp> } {
  const http = fakeHttp(
    o.http ?? {
      responses: [{ status: 200, body: { ok: true, output: { text: 'ok' }, metrics: {} } }],
    },
  );
  return {
    http,
    deps: {
      db: POISONED_DB,
      registry: registryWith(o.dialect ?? stubDialect()),
      http,
      ...(o.budget !== undefined ? { budget: o.budget } : {}),
      ...(o.limits !== undefined ? { limits: o.limits } : {}),
      nowMs: o.nowMs ?? ((): number => NOW.getTime()),
      sleep: (): Promise<void> => Promise.resolve(),
      queries: {
        listActiveCredentialsForChannel: () =>
          Promise.resolve(o.noCredential === true ? [] : [credential('cred-1', 'chan-1')]),
        resolveSupplyCredentialSecret: () =>
          Promise.resolve({ scheme: 'bearer', api_key: 'sk-probe' } as const),
      },
    },
  };
}

/** A stub-dialect variant whose 401 normalizes to `unauthorized` (the stub folds all non-2xx to upstream_error). */
function dialectWithAuthError(): Dialect {
  const d = stubDialect();
  const orig = d.responseNormalization;
  const unauthorized: GatewayError = {
    code: 'unauthorized',
    message: 'invalid api key',
    retryable: false,
    failover: false,
  };
  return {
    ...d,
    responseNormalization: {
      normalize: (res, ctx) =>
        res.status === 401 ? { ok: false, error: unauthorized } : orig.normalize(res, ctx),
      normalizeStreamFrame: (raw, state) => orig.normalizeStreamFrame(raw, state),
    },
  };
}

// --- chat ping verdicts (direct fetch) ------------------------------------------------

describe('goldenProbe — chat ping classification', () => {
  it('passes both legs on a non-empty completion, with a text sample and the messages overlay', async () => {
    const { deps: d, http } = deps();
    const outcome = await goldenProbe(d, subject({}));

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(true);
    expect(outcome.result.sample?.text).toBe('ok');
    expect(outcome.result.operation).toBe('chat.completions');
    // Thin execution: EXACTLY one upstream call, nothing else (db is poisoned;
    // the deps own no task/wallet/semaphore surface at all).
    expect(http.requests).toHaveLength(1);
    const body = http.requests[0]?.body as { messages?: { content?: string }[] };
    expect(body.messages?.[0]?.content).toContain('Reply with the single word: ok');
  });

  it('reached-but-erroring upstream (500): connectivity PASSES, functional fails', async () => {
    const { deps: d } = deps({ http: { responses: [{ status: 500, body: {} }] } });
    const outcome = await goldenProbe(d, subject({}));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(false);
  });

  it('unauthorized fails BOTH legs (bad credential = no connectivity)', async () => {
    const { deps: d } = deps({
      dialect: dialectWithAuthError(),
      http: { responses: [{ status: 401, body: {} }] },
    });
    const outcome = await goldenProbe(d, subject({}));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(false);
    expect(outcome.result.connectivity.code).toBe('unauthorized');
    expect(outcome.result.functional.ok).toBe(false);
  });

  it('raw transport failure fails BOTH legs even though the dialect table folds it to upstream_error (reach tracker)', async () => {
    const { deps: d } = deps({ http: { requestThrows: new Error('ECONNREFUSED 1.2.3.4') } });
    const outcome = await goldenProbe(d, subject({}));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(false);
    expect(outcome.result.connectivity.message).toContain('could not reach upstream');
    expect(outcome.result.functional.ok).toBe(false);
  });

  it('empty completion: connectivity passes, functional fails (the old model-test 判据)', async () => {
    const { deps: d } = deps({
      http: { responses: [{ status: 200, body: { ok: true, output: { text: '  ' } } }] },
    });
    const outcome = await goldenProbe(d, subject({}));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(false);
    expect(outcome.result.functional.message).toContain('empty completion');
  });

  it('stream fetch: drains deltas through pre-commit and passes on assembled text', async () => {
    const { deps: d } = deps({
      http: {
        streamEvents: [
          JSON.stringify({ kind: 'delta', text: 'o' }),
          JSON.stringify({ kind: 'delta', text: 'k' }),
          JSON.stringify({ kind: 'done' }),
        ],
      },
    });
    const outcome = await goldenProbe(d, subject({ mode: 'stream' }));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(true);
    expect(outcome.result.sample?.text).toBe('ok');
  });
});

// --- pre-flight config failures (no upstream byte) --------------------------------------

describe('goldenProbe — pre-flight config verdicts', () => {
  it('empty credential pool: both legs fail with no_credential, ZERO upstream calls', async () => {
    const { deps: d, http } = deps({ noCredential: true });
    const outcome = await goldenProbe(d, subject({}));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(false);
    expect(outcome.result.connectivity.code).toBe('no_credential');
    expect(http.requests).toHaveLength(0);
  });

  it('unregistered dialect pin: both legs fail (方言未注册 is a config defect, not an upstream one)', async () => {
    const { deps: d, http } = deps();
    const s = subject({});
    s.channel.dialect = { ref: 'ghost.dialect', version: 'v9' };
    const outcome = await goldenProbe(d, s);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(false);
    expect(outcome.result.functional.ok).toBe(false);
    expect(http.requests).toHaveLength(0);
  });

  it('a required media input cannot be synthesized: explainable unprobeable_input, ZERO upstream calls', async () => {
    const image: CanonicalParam = {
      name: 'image',
      type: 'media',
      billingRelevant: false,
      required: true,
      mediaKinds: ['image'],
    };
    const { deps: d, http } = deps();
    const outcome = await goldenProbe(
      d,
      subject({ mode: 'submit_poll', operations: [videoOp([image])] }),
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.functional.code).toBe('unprobeable_input');
    expect(http.requests).toHaveLength(0);
  });
});

// --- media/task path: §R5 minimal tier + short bounded poll --------------------------------

const MEDIA_PARAMS: CanonicalParam[] = [
  { name: 'prompt', type: 'string', billingRelevant: false, required: true },
  {
    name: 'duration',
    type: 'int',
    billingRelevant: true,
    required: false,
    min: 1,
    max: 10,
    default: 5,
  },
  {
    name: 'resolution',
    type: 'enum',
    billingRelevant: true,
    required: false,
    values: ['720p', '1080p'],
    default: '1080p',
  },
];

describe('goldenProbe — media/task path (§R5 最小档 + 短轮询)', () => {
  it('forces billing params to the MINIMAL tier (overriding defaults), polls to succeeded, samples the asset URL', async () => {
    const { deps: d, http } = deps({
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-t1' } },
          { status: 200, body: { taskId: 'up-t1', status: 'running' } },
          {
            status: 200,
            body: {
              taskId: 'up-t1',
              status: 'succeeded',
              output: { url: 'https://cdn.test/x.mp4' },
            },
          },
        ],
      },
    });
    const outcome = await goldenProbe(
      d,
      subject({ mode: 'submit_poll', operations: [videoOp(MEDIA_PARAMS)] }),
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(true);
    expect(outcome.result.sample?.url).toBe('https://cdn.test/x.mp4');
    // §R5 服务端强制最小档: duration pinned to min (1, not the default 5);
    // resolution pinned to the first declared value (720p, not the default 1080p).
    const submitBody = http.requests[0]?.body as Record<string, unknown>;
    expect(http.requests[0]?.url).toContain('/mock/submit');
    expect(submitBody.duration).toBe(1);
    expect(submitBody.resolution).toBe('720p');
    expect(submitBody.prompt).toBe('a small red circle on white');
    // submit + 2 polls, nothing else.
    expect(http.requests).toHaveLength(3);
  });

  it('runs the offering declarations through the REAL layer-2 (map rename lands on the wire)', async () => {
    const { deps: d, http } = deps({
      http: {
        responses: [
          {
            status: 200,
            body: {
              taskId: 'up-t1',
              status: 'succeeded',
              output: { url: 'https://cdn.test/y.mp4' },
            },
          },
        ],
      },
    });
    await goldenProbe(
      d,
      subject({
        mode: 'submit_poll',
        operations: [videoOp(MEDIA_PARAMS)],
        declarations: [
          {
            param: 'resolution',
            origin: 'upstream',
            rule: { kind: 'map', upstreamName: 'res', values: { '720p': 'hd' } },
          },
        ],
      }),
    );
    const submitBody = http.requests[0]?.body as Record<string, unknown>;
    expect(submitBody.res).toBe('hd');
    expect(submitBody.resolution).toBeUndefined();
  });

  it('upstream task ends failed: submit connectivity passes, functional carries the upstream error', async () => {
    const { deps: d } = deps({
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-t2' } },
          {
            status: 200,
            body: {
              taskId: 'up-t2',
              status: 'failed',
              error: {
                code: 'task_failed',
                message: 'nsfw rejected',
                retryable: false,
                failover: false,
              },
            },
          },
        ],
      },
    });
    const outcome = await goldenProbe(
      d,
      subject({ mode: 'submit_poll', operations: [videoOp(MEDIA_PARAMS)] }),
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(false);
    expect(outcome.result.functional.message).toContain('nsfw rejected');
  });

  it('poll budget exhausts on a never-terminal task: bounded attempts, functional upstream_timeout', async () => {
    const { deps: d, http } = deps({
      http: {
        responses: [
          { status: 200, body: { taskId: 'up-t3' } },
          { status: 200, body: { taskId: 'up-t3', status: 'running' } },
        ],
      },
    });
    // 1s budget with the default 2.5s cadence ⇒ EXACTLY one poll attempt.
    const outcome = await goldenProbe(
      d,
      subject({
        mode: 'submit_poll',
        operations: [videoOp(MEDIA_PARAMS)],
        timeoutBudgetSeconds: 1,
      }),
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.connectivity.ok).toBe(true);
    expect(outcome.result.functional.ok).toBe(false);
    expect(outcome.result.functional.code).toBe('upstream_timeout');
    expect(http.requests).toHaveLength(2); // submit + 1 bounded poll
  });
});

// --- R5 budget gate ---------------------------------------------------------------------

describe('goldenProbe — R5 探测预算闸', () => {
  it('refuses BEFORE any upstream byte when the daily budget is exhausted', async () => {
    const { deps: d, http } = deps({
      budget: new InMemoryProbeBudget(),
      limits: { dailyBudgetUsd: 0.005, minIntervalSec: 0 }, // < one chat probe (0.01)
    });
    const outcome = await goldenProbe(d, subject({}));
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('budget_exceeded');
    expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a re-probe within the per-offering minimum interval', async () => {
    const budget = new InMemoryProbeBudget();
    const limits = { dailyBudgetUsd: 5, minIntervalSec: 60 };
    const first = deps({ budget, limits });
    expect((await goldenProbe(first.deps, subject({}))).status).toBe('completed');

    const second = deps({ budget, limits, nowMs: () => NOW.getTime() + 10_000 });
    const outcome = await goldenProbe(second.deps, subject({}));
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('min_interval');
    expect(outcome.retryAfterSeconds).toBe(50);
    expect(second.http.requests).toHaveLength(0);
  });

  it('BYOK channels (tenant key) skip the PLATFORM budget — the cost is the tenant’s', async () => {
    const { deps: d } = deps({
      budget: new InMemoryProbeBudget(),
      limits: { dailyBudgetUsd: 0.005, minIntervalSec: 0 }, // would refuse a platform probe
    });
    const outcome = await goldenProbe(d, subject({ tenantId: 'tenant-byok' }));
    expect(outcome.status).toBe('completed');
  });

  it('the budget accumulator rolls at the UTC day boundary', async () => {
    const budget = new InMemoryProbeBudget();
    const limits = { dailyBudgetUsd: 0.01, minIntervalSec: 0 }; // exactly one chat probe/day
    const day1 = deps({ budget, limits });
    expect((await goldenProbe(day1.deps, subject({}))).status).toBe('completed');
    const sameDay = deps({ budget, limits, nowMs: () => NOW.getTime() + 1_000 });
    expect((await goldenProbe(sameDay.deps, subject({}))).status).toBe('rejected');
    const nextDay = deps({ budget, limits, nowMs: () => NOW.getTime() + 24 * 3600 * 1000 });
    expect((await goldenProbe(nextDay.deps, subject({}))).status).toBe('completed');
  });
});
