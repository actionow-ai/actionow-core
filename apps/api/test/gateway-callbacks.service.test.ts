// 批次4 slice4 — GatewayCallbacksService unit tests (fake repo surface + a
// spy dialect through the REAL SPI handleCallback): the §3 chain 验签→去重→
// 乱序容忍→反查确认. Red lines: an unverified callback is REJECTED UNPARSED
// (verify-before-parse, the envelope 断链 fix); correlation is scoped to the
// VERIFIED offering (shared upstream handles cannot cross-talk); a callback
// onto an ALREADY-terminal task short-circuits to stale BEFORE the confirm
// query (去重先于反查 — zero upstream amplification on replays); a terminal
// callback on a live task is folded only after the upstream CONFIRMS it
// (query-back); an unconfirmable terminal defers to the poll backstop (回调
// 不取代轮询 — 双保险); a non-succeeded mid-state can never fail a task from
// this path; one broken pool verification template never blocks a sibling
// secret (§2.4 逐个验签); the §7.5 persist hook rides the fold (转存先于
// succeeded on the callback path too).
import type { CredentialSecret, HttpClient, HttpResponse, TaskUpdate } from '@actionow/contracts';
import type { Database, SupplyChannelRow, SupplyOfferingRow, TaskRow } from '@actionow/db';
import type { ApplyTaskUpdateOutcome, GatewaySettleRepo, PersistHook } from '@actionow/engine';
import { applyTaskUpdate } from '@actionow/engine';
import type { Dialect } from '@actionow/spi';
import { DialectRegistry } from '@actionow/spi';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayCallbackQueries } from '../src/gateway/gateway-callbacks.service.js';
import { GatewayCallbacksService } from '../src/gateway/gateway-callbacks.service.js';
import { taskRow } from './gateway-fixtures.js';

// --- spy dialect ---------------------------------------------------------------------

interface SpyDialect {
  dialect: Dialect;
  parseCallbackSpy: ReturnType<typeof vi.fn>;
}

/**
 * verifyCallback: header `x-mock-signature` must equal `sig-<api_key>`
 * (secret-bound). The sentinel key 'BOOM' THROWS — a broken per-secret
 * verification template (the FIX5 pool-robustness scenario).
 */
function spyDialect(): SpyDialect {
  const parseCallbackSpy = vi.fn((raw: { rawBody: string }) => JSON.parse(raw.rawBody) as never);
  const dialect: Dialect = {
    ref: 'cb.dialect',
    version: 'v1',
    operations: { 'video.generation': { fetchModes: ['submit_callback'] } },
    requestMapping: { map: () => ({ method: 'POST', path: '/run', bodyKind: 'json' }) },
    credentialInjection: { injectCredential: (draft) => draft },
    responseNormalization: {
      normalize: () => ({
        ok: false,
        error: { code: 'internal_error', message: 'unused', retryable: false, failover: false },
      }),
      normalizeStreamFrame: () => [],
    },
    taskLifecycle: {
      buildSubmit: () => ({ method: 'POST', path: '/cb/submit', bodyKind: 'json' }),
      parseSubmitResponse: () => ({ upstreamTaskId: 'up-1' }),
      buildQuery: (id) => ({ method: 'GET', path: `/cb/tasks/${id}`, bodyKind: 'none' }),
      parseQueryResponse: (res) => res.body as TaskUpdate,
      verifyCallback: (raw, secret) => {
        if (secret !== undefined && 'api_key' in secret && secret.api_key === 'BOOM') {
          throw new Error('broken verification template');
        }
        return (
          secret !== undefined &&
          'api_key' in secret &&
          raw.headers['x-mock-signature'] === `sig-${secret.api_key}`
        );
      },
      parseCallback: parseCallbackSpy,
    },
    errorTable: {
      rows: [],
      fallback: { code: 'upstream_error', retryable: false, failover: false },
    },
  };
  return { dialect, parseCallbackSpy };
}

// --- harness --------------------------------------------------------------------------

const OFFERING = {
  id: 'off-1',
  channelId: 'chan-1',
  upstreamModelName: 'up-model',
} as unknown as SupplyOfferingRow;

const CHANNEL = {
  id: 'chan-1',
  providerId: 'prov-1',
  dialect: { ref: 'cb.dialect', version: 'v1' },
  baseUrl: 'https://upstream.test',
  region: null,
  proxyRef: null,
} as unknown as SupplyChannelRow;

const SECRET: CredentialSecret = { scheme: 'bearer', api_key: 'k1' };

interface Harness {
  service: GatewayCallbacksService;
  queries: GatewayCallbackQueries;
  parseCallbackSpy: ReturnType<typeof vi.fn>;
  applySpy: ReturnType<typeof vi.fn>;
  sent: { url: string; body: unknown }[];
}

function harness(
  o: {
    task?: ReturnType<typeof taskRow> | undefined;
    applyOutcome?: ApplyTaskUpdateOutcome;
    confirmBody?: unknown;
    confirmStatus?: number;
  } = {},
): Harness {
  const { dialect, parseCallbackSpy } = spyDialect();
  const registry = new DialectRegistry();
  registry.register(dialect);

  const sent: Harness['sent'] = [];
  const http: HttpClient = {
    request(req): Promise<HttpResponse> {
      sent.push({ url: req.url, body: req.body });
      const status = o.confirmStatus ?? 200;
      return Promise.resolve({
        status,
        ok: status < 400,
        body: o.confirmBody ?? null,
        text: JSON.stringify(o.confirmBody ?? null),
      });
    },
  };

  const queries: GatewayCallbackQueries = {
    getSupplyOfferingById: vi.fn().mockResolvedValue(OFFERING),
    getSupplyChannelById: vi.fn().mockResolvedValue(CHANNEL),
    getSupplyProviderById: vi.fn().mockResolvedValue(undefined),
    listActiveCredentialsForChannel: vi.fn().mockResolvedValue([{ id: 'cred-1' }]),
    resolveSupplyCredentialSecret: vi.fn().mockResolvedValue(SECRET),
    getTaskByUpstreamTaskIdForOffering: vi
      .fn()
      .mockResolvedValue(
        'task' in o ? o.task : taskRow({ status: 'running', offeringId: 'off-1' }),
      ),
  };

  const service = new GatewayCallbacksService({} as Database, registry, http);
  (service as unknown as { queries: GatewayCallbackQueries }).queries = queries;
  const applySpy = vi.fn().mockResolvedValue(o.applyOutcome ?? { kind: 'progress' });
  (service as unknown as { apply: unknown }).apply = applySpy;

  return { service, queries, parseCallbackSpy, applySpy, sent };
}

const GOOD_HEADERS = { 'x-mock-signature': 'sig-k1' };
const NOW = new Date('2026-07-12T12:00:00.000Z');

function body(update: Partial<TaskUpdate> & { upstreamTaskId: string; status: string }): Buffer {
  return Buffer.from(JSON.stringify(update), 'utf8');
}

// --- tests ------------------------------------------------------------------------------

describe('GatewayCallbacksService — §3 验签 (verify-before-parse)', () => {
  it('rejects a bad signature 401 and NEVER parses the body (断链 fix)', async () => {
    const h = harness();
    await expect(
      h.service.ingest(
        'off-1',
        body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
        { 'x-mock-signature': 'sig-WRONG' },
        NOW,
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    expect(h.parseCallbackSpy).not.toHaveBeenCalled(); // 验签过才 parse
    expect(h.applySpy).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  it('rejects an unknown offering 401 without touching the body', async () => {
    const h = harness();
    (h.queries.getSupplyOfferingById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await expect(
      h.service.ingest(
        'off-x',
        body({ upstreamTaskId: 'up-1', status: 'running' }),
        GOOD_HEADERS,
        NOW,
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    expect(h.parseCallbackSpy).not.toHaveBeenCalled();
  });
});

describe('GatewayCallbacksService — 去重/correlation', () => {
  it('an unknown upstream handle answers 404 (the upstream retries; our handle write may lag)', async () => {
    const h = harness({ task: undefined });
    await expect(
      h.service.ingest(
        'off-1',
        body({ upstreamTaskId: 'up-?', status: 'running' }),
        GOOD_HEADERS,
        NOW,
      ),
    ).rejects.toMatchObject({ unified: { code: 'resource_not_found' } });
    expect(h.applySpy).not.toHaveBeenCalled();
  });

  it('the redundant offering guard still rejects a drifted query result (defense in depth)', async () => {
    // The scoped query makes this unreachable in production; if the query is
    // ever swapped for an unscoped one, the guard catches the mismatch.
    const h = harness({ task: taskRow({ status: 'running', offeringId: 'off-OTHER' }) });
    await expect(
      h.service.ingest(
        'off-1',
        body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
        GOOD_HEADERS,
        NOW,
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    expect(h.applySpy).not.toHaveBeenCalled();
  });

  it('FIX2: correlation is SCOPED to the verified offering — a shared handle cannot cross-talk', async () => {
    // Offerings A ('off-OTHER') and B ('off-1') share the upstream handle
    // 'job-100'. The scoped lookup asked FOR off-1 must answer B's task —
    // never A's row (which the old global LIMIT-1 could return unordered).
    const taskB = taskRow({ id: 'task-B', status: 'running', offeringId: 'off-1' });
    const h = harness({ applyOutcome: { kind: 'progress' } });
    const scoped = h.queries.getTaskByUpstreamTaskIdForOffering as ReturnType<typeof vi.fn>;
    scoped.mockImplementation((_db: unknown, handle: string, offeringId: string) =>
      Promise.resolve(handle === 'job-100' && offeringId === 'off-1' ? taskB : undefined),
    );

    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'job-100', status: 'running', progress: 10 }),
      GOOD_HEADERS,
      NOW,
    );

    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'progress' });
    expect(scoped).toHaveBeenCalledWith(expect.anything(), 'job-100', 'off-1');
    expect(h.applySpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'task-B', offeringId: 'off-1' }),
      expect.objectContaining({ upstreamTaskId: 'job-100' }),
      'callback',
    );
  });
});

describe('GatewayCallbacksService — FIX1 去重先于反查 (terminal short-circuit)', () => {
  it.each(['succeeded', 'failed', 'canceled', 'expired'] as const)(
    'a terminal callback onto an already-%s task answers stale with ZERO upstream queries',
    async (status) => {
      const h = harness({ task: taskRow({ status, offeringId: 'off-1' }) });
      const res = await h.service.ingest(
        'off-1',
        body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
        GOOD_HEADERS,
        NOW,
      );
      expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'stale' });
      expect(h.sent).toHaveLength(0); // NO 反查 runTaskQuery — 上游零放大
      expect(h.applySpy).not.toHaveBeenCalled(); // nothing folded either
    },
  );

  it('a LATE mid-state callback onto a terminal task is also stale (乱序, no write)', async () => {
    const h = harness({ task: taskRow({ status: 'succeeded', offeringId: 'off-1' }) });
    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'running', progress: 90 }),
      GOOD_HEADERS,
      NOW,
    );
    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'stale' });
    expect(h.sent).toHaveLength(0);
    expect(h.applySpy).not.toHaveBeenCalled();
  });
});

describe('GatewayCallbacksService — 乱序容忍 + 反查确认 (§3 双保险)', () => {
  it('a non-terminal callback folds directly (progress fast path, NO confirm round-trip)', async () => {
    const h = harness({ applyOutcome: { kind: 'progress' } });
    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'running', progress: 40 }),
      GOOD_HEADERS,
      NOW,
    );
    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'progress' });
    expect(h.sent).toHaveLength(0); // no query-back for mid-states
    expect(h.applySpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offeringId: 'off-1' }),
      expect.objectContaining({ status: 'running', progress: 40 }),
      'callback',
    );
  });

  it('a succeeded callback is folded only after the upstream CONFIRMS it (query-back wins)', async () => {
    const h = harness({
      applyOutcome: { kind: 'settled' },
      confirmBody: {
        upstreamTaskId: 'up-1',
        status: 'succeeded',
        output: { url: 'https://cdn.example/CONFIRMED.mp4' },
      },
    });
    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'succeeded', output: { url: 'callback-claimed' } }),
      GOOD_HEADERS,
      NOW,
    );
    expect(res).toEqual({ status: 'accepted', settled: true, outcome: 'settled' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe('https://upstream.test/cb/tasks/up-1');
    // The CONFIRMED update (not the raw callback claim) is what settles.
    expect(h.applySpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ output: { url: 'https://cdn.example/CONFIRMED.mp4' } }),
      'callback',
    );
  });

  it('an unconfirmable terminal defers to the poll backstop (回调不取代轮询)', async () => {
    const h = harness({ confirmStatus: 500 });
    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
      GOOD_HEADERS,
      NOW,
    );
    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'unconfirmed' });
    expect(h.applySpy).not.toHaveBeenCalled(); // nothing written — poller converges
  });

  it('a premature FAILED callback whose query-back still reports running does NOT fail the task', async () => {
    const h = harness({
      confirmBody: { upstreamTaskId: 'up-1', status: 'running', progress: 90 },
    });
    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'failed' }),
      GOOD_HEADERS,
      NOW,
    );
    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'unconfirmed' });
    expect(h.applySpy).not.toHaveBeenCalled(); // 乱序中间态不误 fail
  });

  it('a duplicate terminal callback converges to stale via the from-guard (evt 去重)', async () => {
    const h = harness({
      applyOutcome: { kind: 'stale' },
      confirmBody: { upstreamTaskId: 'up-1', status: 'succeeded' },
    });
    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
      GOOD_HEADERS,
      NOW,
    );
    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'stale' });
  });
});

// --- FIX5: 池验签健壮性 (§2.4 逐个验签 — one broken template never dams the pool) ---------

describe('GatewayCallbacksService — FIX5 pool verification robustness', () => {
  it('a secret whose verify template THROWS is skipped; the NEXT pool secret verifies', async () => {
    const h = harness({ applyOutcome: { kind: 'progress' } });
    (h.queries.listActiveCredentialsForChannel as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'cred-broken' },
      { id: 'cred-2' },
    ]);
    (h.queries.resolveSupplyCredentialSecret as ReturnType<typeof vi.fn>).mockImplementation(
      (_db: unknown, id: string) =>
        Promise.resolve(
          id === 'cred-broken'
            ? ({ scheme: 'bearer', api_key: 'BOOM' } as const) // verifyCallback THROWS for this key
            : ({ scheme: 'bearer', api_key: 'k2' } as const),
        ),
    );

    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'running', progress: 40 }),
      { 'x-mock-signature': 'sig-k2' }, // signed by the SECOND pool key
      NOW,
    );

    // Before FIX5 the thrown internal_error was misread as "verified but
    // unparseable" → 400 and the pool walk stopped; now k2 authenticates.
    expect(res).toEqual({ status: 'accepted', settled: false, outcome: 'progress' });
    expect(h.parseCallbackSpy).toHaveBeenCalledTimes(1);
  });

  it('a VERIFIED-but-unparseable body still answers 400 without brute-forcing the pool', async () => {
    const h = harness();
    (h.queries.listActiveCredentialsForChannel as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'cred-1' },
      { id: 'cred-2' },
    ]); // both resolve to k1 (the harness default secret)

    await expect(
      h.service.ingest('off-1', Buffer.from('not-json', 'utf8'), GOOD_HEADERS, NOW),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
    // The FIRST secret verified and its parse failed — the pool walk STOPPED.
    expect(h.parseCallbackSpy).toHaveBeenCalledTimes(1);
    expect(h.applySpy).not.toHaveBeenCalled();
  });

  it('a pool of only throwing/refusing legs answers 401 (nothing verified — not 400)', async () => {
    const h = harness();
    (h.queries.resolveSupplyCredentialSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      scheme: 'bearer',
      api_key: 'BOOM',
    } as const);

    await expect(
      h.service.ingest(
        'off-1',
        body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
        { 'x-mock-signature': 'sig-nobody' },
        NOW,
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    expect(h.parseCallbackSpy).not.toHaveBeenCalled(); // 验签过才 parse holds
  });
});

// --- FIX3: §7.5 persist seam (转存先于 succeeded on the CALLBACK path too) -----------------

describe('GatewayCallbacksService — FIX3 persist seam', () => {
  it('the injected persist hook rides into the fold deps (structurally injectable)', async () => {
    const h = harness({ applyOutcome: { kind: 'progress' } });
    const persist = vi.fn();
    (h.service as unknown as { persist: unknown }).persist = persist;

    await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'running', progress: 5 }),
      GOOD_HEADERS,
      NOW,
    );

    expect(h.applySpy).toHaveBeenCalledWith(
      expect.objectContaining({ persist }),
      expect.anything(),
      expect.anything(),
      'callback',
    );
  });

  /** Wire the REAL applyTaskUpdate over a recording settle repo (no db). */
  function realFoldHarness(o: { persistOk: boolean }): {
    h: Harness;
    persist: ReturnType<typeof vi.fn>;
    order: string[];
    settles: unknown[];
    fails: unknown[];
  } {
    const order: string[] = [];
    const settles: unknown[] = [];
    const fails: unknown[] = [];
    const persist = vi.fn(() => {
      order.push('persist');
      return Promise.resolve(
        o.persistOk
          ? ({ ok: true, output: { url: 'platform://persisted.mp4' } } as const)
          : ({
              ok: false,
              error: {
                code: 'internal_error' as const,
                message: 'R2 transfer failed',
                retryable: false,
                failover: false,
              },
            } as const),
      );
    });
    const settleRepo = {
      settleGatewayTask: (_db: unknown, input: unknown) => {
        order.push('settle');
        settles.push(input);
        return Promise.resolve({ settled: true });
      },
      failGatewayTask: (_db: unknown, input: unknown) => {
        order.push('fail');
        fails.push(input);
        return Promise.resolve({ settled: true });
      },
      getSupplyPriceCardsByIdsIncludingDeleted: () => Promise.resolve(new Map()),
    } as unknown as Partial<GatewaySettleRepo>;

    const requirePersistTask = taskRow({
      status: 'running',
      offeringId: 'off-1',
      accountId: 'acct-1',
      holdAmount: 5_000n,
      inputs: {
        effective: { canonical: {}, upstream: {} },
        billingDims: {},
        modifiers: [],
        options: { requirePersist: true },
      },
    });
    const h = harness({
      task: requirePersistTask,
      confirmBody: {
        upstreamTaskId: 'up-1',
        status: 'succeeded',
        output: { url: 'https://upstream/raw.mp4' },
      },
    });
    (h.service as unknown as { persist: PersistHook }).persist = persist;
    // The real fold, with the recorder standing in for the db settle layer.
    (h.service as unknown as { apply: unknown }).apply = (
      deps: Parameters<typeof applyTaskUpdate>[0],
      task: TaskRow,
      update: TaskUpdate,
      source: 'poll' | 'callback',
    ) => applyTaskUpdate({ ...deps, settleRepo }, task, update, source);
    return { h, persist, order, settles, fails };
  }

  it('a callback-won settle runs 转存 BEFORE the settle transaction (§7.5 转存先于 succeeded)', async () => {
    const { h, persist, order, settles, fails } = realFoldHarness({ persistOk: true });

    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
      GOOD_HEADERS,
      NOW,
    );

    expect(res).toEqual({ status: 'accepted', settled: true, outcome: 'settled' });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['persist', 'settle']); // 转存严格先于 settle
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ output: { url: 'platform://persisted.mp4' } });
    expect(fails).toHaveLength(0);
  });

  it('require_persist + persist failure → the callback path FAILS without charge (对称 poll 路径)', async () => {
    const { h, persist, order, settles, fails } = realFoldHarness({ persistOk: false });

    const res = await h.service.ingest(
      'off-1',
      body({ upstreamTaskId: 'up-1', status: 'succeeded' }),
      GOOD_HEADERS,
      NOW,
    );

    // `settled: true` = THIS fold performed the terminal write — but it is the
    // FAIL write: zero settle, zero charge.
    expect(res).toEqual({ status: 'accepted', settled: true, outcome: 'failed' });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['persist', 'fail']); // NO settle — 失败即 fail 不扣费
    expect(settles).toHaveLength(0);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({
      error: expect.objectContaining({ message: 'R2 transfer failed' }),
    });
  });
});
