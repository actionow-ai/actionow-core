// Shared handwritten fixtures for the slice2 gateway tests: a mock Dialect
// (hand-written runSync/runTaskSubmit-compatible aspect stubs) driven through
// the REAL SPI pipeline over a fake HttpClient, a fake plan (handcrafted
// Reservation with recording release()), and in-memory task/settle repos —
// no live db anywhere (POISONED_DB throws on any direct access).
import type {
  BillingDims,
  CanonicalParamValue,
  EffectiveParams,
  FetchMode,
  GatewayError,
  GatewayRequest,
  GatewayUsage,
  HttpClient,
  HttpResponse,
  HttpStreamResponse,
  Paradigm,
  PriceSpec,
} from '@actionow/contracts';
import type {
  DbOrTx,
  SupplyModelRow,
  SupplyPriceCardRow,
  SupplyProviderRow,
  TaskRow,
} from '@actionow/db';
import type { Dialect } from '@actionow/spi';
import { DialectRegistry } from '@actionow/spi';

import type {
  ExecuteGatewayDeps,
  GatewaySettleRepo,
  GatewayTaskRepo,
  PlanSuccess,
  Reservation,
} from '../../src/index.js';
import { credential, modelOp, NOW, offering, T0 } from '../planner/supply-fixtures.js';

export { credential, modelOp, NOW, offering, T0 };

/** Any direct db access is a red-line violation — all reads/writes go through fakes. */
export const POISONED_DB = new Proxy(
  {},
  {
    get(_t, prop): never {
      throw new Error(`red-line violation: gateway touched db.${String(prop)} directly`);
    },
  },
) as unknown as DbOrTx;

// --- rows --------------------------------------------------------------------------

export function modelRow(
  o: {
    id?: string;
    name?: string;
    operations?: SupplyModelRow['operations'];
    maxRunTimeSeconds?: number | null;
    priceCardId?: string | null;
  } = {},
): SupplyModelRow {
  return {
    id: o.id ?? 'model-1',
    name: o.name ?? 'test-model',
    displayName: 'Test Model',
    icon: null,
    status: 'active',
    modality: 'text',
    operations: o.operations ?? [modelOp('chat.completions')],
    capabilities: [],
    priceCardId: o.priceCardId ?? 'card-sale',
    modifierGroupId: null,
    maxRunTimeSeconds: o.maxRunTimeSeconds ?? null,
    artifact: { mode: 'signed', retention_days: null },
    fallbackModelIds: [],
    limitPlanId: null,
    visibility: 'public',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
}

export function providerRow(o: { slug?: string; dialectRef?: string } = {}): SupplyProviderRow {
  return {
    id: 'prov-1',
    slug: o.slug ?? 'mockbrand',
    name: 'Mock Brand',
    icon: null,
    defaultDialect: { ref: o.dialectRef ?? 'mock.dialect', version: 'v1' },
    callbackVerification: null,
    defaultFaultPolicyId: null,
    region: null,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
}

// --- mock dialect (real SPI pipeline over a fake HttpClient) --------------------------

/** A minimal but COMPLETE Dialect: absolute-path drafts, bearer injection, JSON normalize, SSE frames, task lifecycle. */
export function stubDialect(o: { ref?: string; version?: string } = {}): Dialect {
  return {
    ref: o.ref ?? 'mock.dialect',
    version: o.version ?? 'v1',
    operations: {
      'chat.completions': { fetchModes: ['direct', 'stream', 'submit_poll', 'submit_callback'] },
      'video.generation': { fetchModes: ['direct', 'submit_poll', 'submit_callback'] },
    },
    requestMapping: {
      map: (input) => ({
        method: 'POST',
        path: input.stream ? '/mock/stream' : '/mock/run',
        bodyKind: 'json',
        body: { model: input.upstreamModelName, ...input.params.upstream, stream: input.stream },
      }),
    },
    credentialInjection: {
      injectCredential: (draft, secret) => ({
        ...draft,
        headers: {
          ...(draft.headers ?? {}),
          authorization: `Bearer ${'api_key' in secret ? secret.api_key : 'none'}`,
        },
      }),
    },
    responseNormalization: {
      normalize: (res) => {
        const body = res.body as
          | { ok?: boolean; output?: unknown; metrics?: Record<string, number> }
          | undefined;
        if (res.status === 200 && body?.ok === true) {
          return {
            ok: true,
            output: body.output,
            usage: { metrics: body.metrics ?? {}, billingDims: {}, estimated: false },
          };
        }
        return {
          ok: false,
          error: {
            code: res.status === 429 ? 'rate_limited' : 'upstream_error',
            message: `mock upstream HTTP ${String(res.status)}`,
            retryable: res.status >= 500,
            failover: res.status >= 500,
          },
        };
      },
      normalizeStreamFrame: (raw) => {
        if (raw === '[DONE]') return [];
        const evt = JSON.parse(raw) as {
          kind: string;
          text?: string;
          usage?: GatewayUsage;
          message?: string;
        };
        if (evt.kind === 'delta') return [{ kind: 'delta', payload: evt.text }];
        if (evt.kind === 'done') {
          return [{ kind: 'done', ...(evt.usage !== undefined ? { usage: evt.usage } : {}) }];
        }
        if (evt.kind === 'error') {
          return {
            error: {
              code: 'upstream_error',
              message: evt.message ?? 'mock stream error',
              retryable: false,
              failover: false,
            },
          };
        }
        return [];
      },
    },
    taskLifecycle: {
      buildSubmit: (input) => ({
        method: 'POST',
        path: '/mock/submit',
        bodyKind: 'json',
        body: { model: input.upstreamModelName, ...input.params.upstream },
      }),
      parseSubmitResponse: (res) => {
        const body = res.body as {
          taskId?: string;
          inline?: { output: unknown; usage: GatewayUsage };
          error?: string;
        };
        if (body.taskId !== undefined) return { upstreamTaskId: body.taskId };
        if (body.inline !== undefined) return { inline: body.inline };
        return {
          error: {
            code: 'upstream_error',
            message: body.error ?? 'mock submit rejected',
            retryable: false,
            failover: false,
          },
        };
      },
      buildQuery: (id) => ({ method: 'GET', path: `/mock/tasks/${id}`, bodyKind: 'none' }),
      parseQueryResponse: (res) => {
        const body = res.body as {
          taskId: string;
          status: string;
          progress?: number;
          output?: unknown;
          usage?: GatewayUsage;
          error?: GatewayError;
        };
        return {
          upstreamTaskId: body.taskId,
          status: body.status as 'running',
          ...(body.progress !== undefined ? { progress: body.progress } : {}),
          ...(body.output !== undefined ? { output: body.output } : {}),
          ...(body.usage !== undefined ? { usage: body.usage } : {}),
          ...(body.error !== undefined ? { error: body.error } : {}),
        };
      },
      verifyCallback: () => true,
      parseCallback: (raw) => JSON.parse(raw.rawBody) as never,
    },
    errorTable: {
      rows: [
        { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: false },
        {
          match: { httpStatus: [500, 599] },
          code: 'upstream_error',
          retryable: true,
          failover: true,
        },
        { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
        { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
      ],
      fallback: { code: 'upstream_error', retryable: false, failover: false },
    },
  };
}

export function registryWith(...dialects: Dialect[]): DialectRegistry {
  const registry = new DialectRegistry();
  for (const d of dialects) registry.register(d);
  return registry;
}

// --- fake HttpClient --------------------------------------------------------------------

export interface FakeHttpScript {
  /** Buffered request answers, consumed in order (last one repeats). */
  responses?: Partial<HttpResponse>[];
  /** request() rejects with this error instead of answering. */
  requestThrows?: Error;
  /** Stream open status + raw SSE payload lines (each becomes one `data:` event). */
  streamStatus?: number;
  streamEvents?: string[];
}

export interface FakeHttp extends HttpClient {
  /** Every outbound request, in order (asserting 先落库再调上游 etc.). */
  requests: { url: string; body: unknown; headers: Record<string, string> | undefined }[];
  /** Shared event log entries pushed as 'http:<path>' on every call. */
  log: string[];
}

export function fakeHttp(script: FakeHttpScript = {}, log: string[] = []): FakeHttp {
  const requests: FakeHttp['requests'] = [];
  let i = 0;
  const client: FakeHttp = {
    requests,
    log,
    request(req): Promise<HttpResponse> {
      requests.push({ url: req.url, body: req.body, headers: req.headers });
      log.push(`http:${new URL(req.url).pathname}`);
      if (script.requestThrows !== undefined) return Promise.reject(script.requestThrows);
      const scripted = script.responses?.[Math.min(i, (script.responses.length || 1) - 1)];
      i += 1;
      const res: HttpResponse = {
        status: scripted?.status ?? 200,
        ok: (scripted?.status ?? 200) < 400,
        body: scripted?.body,
        text: scripted?.text ?? JSON.stringify(scripted?.body ?? null),
      };
      return Promise.resolve(res);
    },
    stream(req): Promise<HttpStreamResponse> {
      requests.push({ url: req.url, body: req.body, headers: req.headers });
      log.push(`http-stream:${new URL(req.url).pathname}`);
      const status = script.streamStatus ?? 200;
      const events = script.streamEvents ?? [];
      async function* lines(): AsyncGenerator<string> {
        if (status >= 400) {
          yield JSON.stringify({ error: 'mock stream open failed' });
          return;
        }
        for (const evt of events) {
          yield `data: ${evt}\n\n`;
          await Promise.resolve();
        }
      }
      return Promise.resolve({ status, ok: status < 400, lines: lines() });
    },
  };
  return client;
}

// --- fake plan / reservation ---------------------------------------------------------------

export interface FakeReservationInput {
  offeringId?: string;
  channelId?: string;
  mode?: FetchMode;
  holdAmount?: bigint;
  effective?: EffectiveParams;
  billingDims?: BillingDims;
  costCard?: boolean;
  log?: string[];
}

export interface FakeReservation {
  reservation: Reservation;
  /** 'release:full' (slot+hold rollback) / 'release:slot' entries, in order. */
  log: string[];
}

export function fakeReservation(o: FakeReservationInput = {}): FakeReservation {
  const log = o.log ?? [];
  const cand = offering({
    id: o.offeringId ?? 'off-1',
    channelId: o.channelId ?? 'chan-1',
    mode: o.mode ?? 'direct',
  });
  // The stub dialect emits channel-relative paths — give the channel a base URL.
  (cand.channel as { baseUrl: string | null }).baseUrl = 'https://upstream.test';
  let released = false;
  const reservation: Reservation = {
    candidate: {
      offering: cand,
      effective: o.effective ?? { canonical: {}, upstream: {} },
      billingDims: o.billingDims ?? {},
      activeCredentialCount: 1,
    },
    credential: credential('cred-1', cand.channelId),
    slot: {
      offeringId: cand.id,
      credentialId: 'cred-1',
      release: (): Promise<void> => {
        log.push('release:slot');
        return Promise.resolve();
      },
    },
    fetchPlan: {
      mode: cand.fetchProfile.mode,
      recoverable:
        cand.fetchProfile.mode === 'submit_poll' || cand.fetchProfile.mode === 'submit_callback',
      atMostOnce: cand.fetchProfile.mode === 'direct',
      preCommit: cand.fetchProfile.mode === 'stream',
    },
    paradigmPlan: { externalParadigm: 'sync', autoUpgraded: false, reason: 'fixture' },
    holdAmount: o.holdAmount ?? 5_000n,
    holdTxn: {
      wallet: { kind: 'tenant', accountId: 'acct-1', tenantId: 'tenant-1' },
      amount: o.holdAmount ?? 5_000n,
    },
    saleCardRef: { cardId: 'card-sale', version: 3 },
    costCardRef: o.costCard === false ? null : { cardId: 'card-cost', version: 1 },
    release: (): Promise<void> => {
      if (released) return Promise.resolve();
      released = true;
      log.push('release:full');
      return Promise.resolve();
    },
  };
  return { reservation, log };
}

export interface FakePlanInput extends FakeReservationInput {
  paradigm?: Exclude<Paradigm, 'realtime'>;
  autoUpgraded?: boolean;
  model?: SupplyModelRow;
  timeoutBudgetSeconds?: number | null;
}

export function fakePlan(o: FakePlanInput = {}): { plan: PlanSuccess; log: string[] } {
  const { reservation, log } = fakeReservation(o);
  if (o.timeoutBudgetSeconds !== undefined) {
    // RoutingCandidate is a plain fixture object — adjust the budget in place.
    (
      reservation.candidate.offering as { timeoutBudgetSeconds: number | null }
    ).timeoutBudgetSeconds = o.timeoutBudgetSeconds;
  }
  const paradigmPlan = {
    externalParadigm: o.paradigm ?? 'sync',
    autoUpgraded: o.autoUpgraded ?? false,
    reason: 'fixture',
  };
  reservation.paradigmPlan = paradigmPlan;
  const plan: PlanSuccess = {
    ok: true,
    reservation,
    paradigmPlan,
    fetchPlan: reservation.fetchPlan,
    effective: reservation.candidate.effective,
    billingDims: reservation.candidate.billingDims,
    model: o.model ?? modelRow(),
    warnings: [],
    trace: { rejected: [], attempts: [] },
  };
  return { plan, log };
}

// --- in-memory task repo ----------------------------------------------------------------

export interface FakeTaskStore {
  repo: GatewayTaskRepo;
  tasks: Map<string, TaskRow>;
  events: { taskId: string; from: string | null; to: string; payload: unknown }[];
  log: string[];
}

let taskSeq = 0;

export function taskRowOf(over: Partial<TaskRow> = {}): TaskRow {
  taskSeq += 1;
  return {
    id: over.id ?? `task-${String(taskSeq)}`,
    tenantId: 'tenant-1',
    apiKeyId: 'key-1',
    subjectId: null,
    operation: 'chat.completions',
    modelId: 'model-1',
    offeringId: null,
    status: 'pending',
    internalSubstate: null,
    progress: null,
    fetchMode: null,
    upstreamTaskId: null,
    ownerNode: null,
    leaseUntil: null,
    maxRunTimeSeconds: null,
    holdExpiresAt: null,
    holdAmount: null,
    accountId: null,
    subAccountId: null,
    estimated: false,
    saleCardRef: null,
    costCardRef: null,
    artifactMode: null,
    artifactExpiresAt: null,
    requestFingerprint: null,
    idempotencyKey: null,
    callbackUrl: null,
    inputs: {},
    output: null,
    usage: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    deletedAt: null,
    ...over,
  };
}

/**
 * An in-memory GatewayTaskRepo faithful to the slice1 semantics the gateway
 * relies on: createTask's idempotency backstop, transitionTask's from-guard +
 * inline event, claim's fingerprint judgment.
 */
export function fakeTaskStore(log: string[] = []): FakeTaskStore {
  const tasks = new Map<string, TaskRow>();
  const events: FakeTaskStore['events'] = [];
  const byIdemKey = (tenantId: string, apiKeyId: string | null, key: string): TaskRow | undefined =>
    [...tasks.values()].find(
      (t) =>
        t.tenantId === tenantId &&
        t.apiKeyId === apiKeyId &&
        t.idempotencyKey === key &&
        t.deletedAt === null,
    );
  const repo: GatewayTaskRepo = {
    claimTaskIdempotency: (_db, input) => {
      log.push('claim');
      const existing = byIdemKey(input.tenantId, input.apiKeyId, input.idempotencyKey);
      if (existing === undefined) return Promise.resolve({ claimed: true });
      return Promise.resolve({
        claimed: false,
        existing,
        fingerprintMatch:
          existing.requestFingerprint !== null && existing.requestFingerprint === input.fingerprint,
      });
    },
    createTask: (_db, input) => {
      log.push('createTask');
      if (input.idempotencyKey != null) {
        const existing = byIdemKey(input.tenantId, input.apiKeyId ?? null, input.idempotencyKey);
        if (existing !== undefined) return Promise.resolve({ task: existing, created: false });
      }
      const row = taskRowOf({ ...(input as Partial<TaskRow>), status: 'pending' });
      tasks.set(row.id, row);
      return Promise.resolve({ task: row, created: true });
    },
    appendTaskEvent: (_db, input) => {
      events.push({
        taskId: input.taskId,
        from: input.fromStatus ?? null,
        to: input.toStatus,
        payload: input.payload,
      });
      return Promise.resolve({
        id: `evt-${String(events.length)}`,
        taskId: input.taskId,
        seq: events.length,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus,
        payload: (input.payload ?? null) as never,
        createdAt: NOW,
      });
    },
    transitionTask: (_db, taskId, from, to, extra) => {
      log.push(`transition:${to}`);
      const row = tasks.get(taskId);
      if (row === undefined || !(from as readonly string[]).includes(row.status)) {
        return Promise.resolve(undefined);
      }
      const { eventPayload, ...columns } = extra ?? {};
      const next: TaskRow = {
        ...row,
        ...(columns as Partial<TaskRow>),
        status: to,
        updatedAt: NOW,
      };
      tasks.set(taskId, next);
      events.push({ taskId, from: row.status, to, payload: eventPayload });
      return Promise.resolve(next);
    },
    getTaskByUpstreamTaskId: (_db, upstreamTaskId) =>
      Promise.resolve(
        [...tasks.values()].find(
          (t) => t.upstreamTaskId === upstreamTaskId && t.deletedAt === null,
        ),
      ),
    // §7.2 in-request 续租, faithful to the real repo: only the CURRENT owner
    // extends; anyone else gets false (lease lost — the caller must stop).
    renewTaskLease: (_db, taskId, ownerNode, leaseUntil) => {
      log.push('lease:renew');
      const row = tasks.get(taskId);
      if (row?.ownerNode !== ownerNode) return Promise.resolve(false);
      tasks.set(taskId, { ...row, leaseUntil });
      return Promise.resolve(true);
    },
  };
  return { repo, tasks, events, log };
}

// --- recording settle repo (the db-transaction layer, faked) --------------------------------

export interface FakeSettleStore {
  repo: Pick<
    GatewaySettleRepo,
    'settleGatewayTask' | 'failGatewayTask' | 'getSupplyPriceCardsByIdsIncludingDeleted'
  >;
  settles: Parameters<GatewaySettleRepo['settleGatewayTask']>[1][];
  fails: Parameters<GatewaySettleRepo['failGatewayTask']>[1][];
  log: string[];
}

export function cardRow(o: {
  id: string;
  version?: number;
  spec?: PriceSpec;
  /** Soft-deletion instant — §2.7 snapshot rebuild must still see the row. */
  deletedAt?: Date | null;
}): SupplyPriceCardRow {
  const spec: PriceSpec = o.spec ?? { method: 'fixed', amount: 5_000 };
  return {
    id: o.id,
    name: o.id,
    method: spec.method,
    unit: 'request',
    tierDims: [],
    spec,
    currency: 'usd',
    version: o.version ?? 1,
    effectiveAt: T0,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: o.deletedAt ?? null,
  };
}

export function saleCardRow(spec?: PriceSpec): SupplyPriceCardRow {
  return cardRow({ id: 'card-sale', version: 3, spec: spec ?? { method: 'fixed', amount: 5_000 } });
}

export function costCardRow(spec?: PriceSpec): SupplyPriceCardRow {
  return cardRow({ id: 'card-cost', version: 1, spec: spec ?? { method: 'fixed', amount: 1_000 } });
}

export function fakeSettleStore(
  o: {
    cards?: SupplyPriceCardRow[];
    taskStore?: FakeTaskStore;
    log?: string[];
  } = {},
): FakeSettleStore {
  const log = o.log ?? [];
  const settles: FakeSettleStore['settles'] = [];
  const fails: FakeSettleStore['fails'] = [];
  const cards = o.cards ?? [saleCardRow(), costCardRow()];
  const repo: FakeSettleStore['repo'] = {
    settleGatewayTask: (_db, input) => {
      log.push('settle');
      settles.push(input);
      let task: TaskRow | undefined;
      if (input.taskId != null && o.taskStore !== undefined) {
        const row = o.taskStore.tasks.get(input.taskId);
        if (row !== undefined && (row.status === 'pending' || row.status === 'running')) {
          task = {
            ...row,
            status: 'succeeded',
            output: input.output ?? null,
            usage: input.usage,
            estimated: input.estimated,
            saleCardRef: input.saleCardRef,
            costCardRef: input.costCardRef,
            finishedAt: NOW,
          };
          o.taskStore.tasks.set(row.id, task);
          o.taskStore.events.push({
            taskId: row.id,
            from: row.status,
            to: 'succeeded',
            payload: undefined,
          });
        } else if (row !== undefined) {
          return Promise.resolve({ settled: false });
        }
      }
      return Promise.resolve({
        settled: true,
        ...(task !== undefined ? { task } : {}),
        balanceAfter: 0n,
      });
    },
    failGatewayTask: (_db, input) => {
      log.push('fail');
      fails.push(input);
      let task: TaskRow | undefined;
      if (o.taskStore !== undefined) {
        const row = o.taskStore.tasks.get(input.taskId);
        if (row !== undefined && (row.status === 'pending' || row.status === 'running')) {
          task = {
            ...row,
            status: input.to ?? 'failed',
            error: input.error ?? null,
            finishedAt: NOW,
          };
          o.taskStore.tasks.set(row.id, task);
        }
      }
      return Promise.resolve({ settled: true, ...(task !== undefined ? { task } : {}) });
    },
    // Faithful to the real repo: soft-deleted rows ARE returned (§2.7 snapshot
    // rebuild) — only ids that never existed are absent.
    getSupplyPriceCardsByIdsIncludingDeleted: (_db, ids) => {
      log.push('price-cards');
      return Promise.resolve(
        new Map(cards.filter((c) => ids.includes(c.id)).map((c) => [c.id, c])),
      );
    },
  };
  return { repo, settles, fails, log };
}

// --- deps assembly ---------------------------------------------------------------------------

export interface GatewayHarness {
  deps: ExecuteGatewayDeps;
  http: FakeHttp;
  taskStore: FakeTaskStore;
  settleStore: FakeSettleStore;
  planLog: string[];
  /** ONE shared ordered event log across http/tasks/settle/plan. */
  log: string[];
}

export function harness(
  o: {
    plan?: PlanSuccess | undefined;
    planError?: GatewayError;
    http?: FakeHttpScript;
    dialect?: Dialect;
    now?: Date;
    deps?: Partial<ExecuteGatewayDeps>;
  } = {},
): GatewayHarness {
  const log: string[] = [];
  const http = fakeHttp(
    o.http ?? {
      responses: [
        { status: 200, body: { ok: true, output: { text: 'hi' }, metrics: { requests: 1 } } },
      ],
    },
    log,
  );
  const taskStore = fakeTaskStore(log);
  const settleStore = fakeSettleStore({ taskStore, log });
  const dialect = o.dialect ?? stubDialect();
  const planLog: string[] = [];
  const deps: ExecuteGatewayDeps = {
    db: POISONED_DB,
    now: () => o.now ?? NOW,
    rng: () => 0,
    limiter: { take: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
    concurrency: {
      acquire: () => Promise.resolve({ ok: true, release: () => Promise.resolve() }),
    },
    nowMs: () => (o.now ?? NOW).getTime(),
    // §3 block-poll pacing — instant in tests.
    sleep: () => Promise.resolve(),
    dialectRegistry: registryWith(dialect),
    spiHttp: http,
    planner: (_deps, input) => {
      planLog.push('plan');
      log.push('plan');
      if (o.planError !== undefined) {
        return Promise.resolve({
          ok: false,
          error: o.planError,
          warnings: [],
          trace: { rejected: [], attempts: [] },
        });
      }
      if (o.plan === undefined) throw new Error('harness: no plan scripted');
      // Faithful single-offering failover semantics: once the scripted plan's
      // offering is excluded (§8 loop), planning fails exactly like the real
      // planExecution with zero remaining candidates.
      const offeringId = o.plan.reservation.candidate.offering.id;
      if (input.excludeOfferingIds?.includes(offeringId) === true) {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'upstream_error',
            message: `no routable supply offering (offering ${offeringId} excluded)`,
            retryable: true,
            failover: false,
          },
          warnings: [],
          trace: { rejected: [], attempts: [] },
        });
      }
      return Promise.resolve(o.plan as never);
    },
    gatewayQueries: {
      getSupplyProviderById: () => {
        log.push('provider');
        return Promise.resolve(providerRow());
      },
      resolveSupplyCredentialSecret: () => {
        log.push('secret');
        return Promise.resolve({ scheme: 'bearer', api_key: 'sk-mock-1234' } as const);
      },
    },
    taskRepo: taskStore.repo,
    settleRepo: settleStore.repo,
    ...o.deps,
  };
  return { deps, http, taskStore, settleStore, planLog, log };
}

export function gatewayRequest(
  o: Partial<GatewayRequest> & { params?: Record<string, CanonicalParamValue> } = {},
): GatewayRequest {
  return {
    tenantId: 'tenant-1',
    apiKeyId: 'key-1',
    operation: o.operation ?? 'chat.completions',
    model: 'test-model',
    params: {},
    mediaRefs: [],
    options: {},
    ...o,
  };
}
