// apps/api/test/gateway-reliability.int.test.ts
//
// model-supply-greenfield 批次4 slice6 — 判据 2.5 TASK-CENTER RELIABILITY over
// a REAL testcontainers postgres: real task/settle/ledger/supply repos, real
// engine recovery/settle funnels; ONLY the upstream wire (HttpClient) and the
// dialect are faked. Verbatim coverage:
//
//   2.5-a worker kill → 租约接管跑完: a running submit_poll task whose owner
//         died (expired lease) is claimed by the sweep, polled to succeeded
//         and SETTLED exactly once (hold released, charge debited, §9.2 dual
//         price snapshot on the ledger).
//   2.5-b direct 崩溃 → failed 不扣费: an orphaned running fetch=direct task
//         is failed by the reaper with the hold released and ZERO ledger
//         charge (§3 at-most-once, platform absorbs).
//   2.5-c 超 15 分钟慢任务不被误杀: hold TTL = max_run + buffer (decoupled
//         from the legacy 15-min default) — at t=+16min neither the hold
//         reaper nor the takeover sweep touches a healthy-leased long task.
//   2.5-d 上游回调打通: 验签 (bad signature → 401, never parsed) → 乱序容忍
//         (in-flight progress folds, never fails) → 反查确认 (a terminal
//         callback is confirmed upstream before settling) → 去重 (a replayed
//         terminal callback is `stale`: no second settle, no second charge,
//         and NO extra upstream confirm round-trip).
//
// Plus the §9.2 reconciliation aggregation (判据 2.6 报表可出): real settles →
// aggregateGatewayReconciliation buckets (sale/cost/margin, cost_missing 标记)
// → renderReport totals.
import { createHmac } from 'node:crypto';

import type {
  CredentialSecret,
  GatewayUsage,
  HttpClient,
  HttpResponse,
  HttpStreamResponse,
  ModelOperation,
  PriceCardSnapshotRef,
} from '@actionow/contracts';
import type { Database, TaskRow } from '@actionow/db';
import {
  aggregateGatewayReconciliation,
  createDb,
  createSupplyChannel,
  createSupplyCredential,
  createSupplyModel,
  createSupplyOffering,
  createSupplyPriceCard,
  createSupplyProvider,
  schema,
} from '@actionow/db';
import type { TaskRecoveryDeps } from '@actionow/engine';
import {
  reapExpiredHoldGatewayTasks,
  reapOrphanedDirectTasks,
  settleGatewayResult,
  sweepRecoverableTasks,
} from '@actionow/engine';
import type { Dialect } from '@actionow/spi';
import { DialectRegistry } from '@actionow/spi';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, like } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { renderReport } from '../src/admin/reconciliation.controller.js';
import { GatewayCallbacksService } from '../src/gateway/gateway-callbacks.service.js';

const VAULT_KEY = Buffer.alloc(32, 11).toString('base64');
/** The channel api key doubles as the mock callback-signing secret. */
const CHANNEL_API_KEY = 'sk-reliability-e2e';

let container: StartedPostgreSqlContainer;
let db: Database;
let originalVaultKey: string | undefined;

beforeAll(async () => {
  originalVaultKey = process.env.SECRET_ENCRYPTION_KEY;
  process.env.SECRET_ENCRYPTION_KEY = VAULT_KEY;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = createDb(container.getConnectionUri());
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 240_000);

afterAll(async () => {
  if (originalVaultKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = originalVaultKey;
  await container.stop();
});

afterEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE webhook_deliveries, task_events, task, ledger_txn, supply_offering_breaker, supply_model_grant, supply_offering, supply_credential, supply_model, supply_channel, supply_provider, supply_price_card, secret_material, secret_ref, api_key, account, tenant RESTART IDENTITY CASCADE`,
  );
});

// --- fake upstream ---------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
}

class ScriptHttp implements HttpClient {
  readonly requests: Recorded[] = [];
  private readonly routes = new Map<string, () => { status: number; body: unknown }>();

  on(method: string, url: string, handler: () => { status: number; body: unknown }): void {
    this.routes.set(`${method} ${url}`, handler);
  }

  request(req: { method: string; url: string }): Promise<HttpResponse> {
    this.requests.push({ method: req.method, url: req.url });
    const handler = this.routes.get(`${req.method} ${req.url}`);
    const res = handler?.() ?? { status: 404, body: { error: 'no route' } };
    return Promise.resolve({
      status: res.status,
      ok: res.status < 400,
      body: res.body,
      text: JSON.stringify(res.body ?? null),
    });
  }

  stream(): Promise<HttpStreamResponse> {
    return Promise.reject(new Error('reliability int: no stream upstreams'));
  }
}

/** One dialect: submit_poll lifecycle + HMAC-verified callbacks (x-mock-signature). */
function mockDialect(): Dialect {
  return {
    ref: 'mock.reliability',
    version: 'v1',
    operations: { 'video.generation': { fetchModes: ['submit_poll', 'submit_callback'] } },
    requestMapping: {
      map: (input) => ({
        method: 'POST',
        path: '/mock/run',
        bodyKind: 'json',
        body: { model: input.upstreamModelName },
      }),
    },
    credentialInjection: {
      injectCredential: (draft, secret: CredentialSecret) => ({
        ...draft,
        headers: {
          ...(draft.headers ?? {}),
          authorization: `Bearer ${secret.scheme === 'bearer' ? secret.api_key : 'none'}`,
        },
      }),
    },
    responseNormalization: {
      normalize: () => ({
        ok: true,
        output: null,
        usage: { metrics: {}, billingDims: {}, estimated: false },
      }),
      normalizeStreamFrame: () => [],
    },
    taskLifecycle: {
      buildSubmit: (input) => ({
        method: 'POST',
        path: '/mock/submit',
        bodyKind: 'json',
        body: { model: input.upstreamModelName },
      }),
      parseSubmitResponse: (res) => {
        const body = res.body as { taskId?: string };
        return body.taskId !== undefined
          ? { upstreamTaskId: body.taskId }
          : {
              error: {
                code: 'upstream_error',
                message: 'mock submit rejected',
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
        };
        return {
          upstreamTaskId: body.taskId,
          status: body.status as 'running',
          ...(body.progress !== undefined ? { progress: body.progress } : {}),
          ...(body.output !== undefined ? { output: body.output } : {}),
          ...(body.usage !== undefined ? { usage: body.usage } : {}),
        };
      },
      // Aspect ⑥ 验签: HMAC-SHA256(channel api key, rawBody) in x-mock-signature.
      verifyCallback: (raw, secret) => {
        if (secret?.scheme !== 'bearer') return false;
        const expected = createHmac('sha256', secret.api_key).update(raw.rawBody).digest('hex');
        return raw.headers['x-mock-signature'] === expected;
      },
      parseCallback: (raw) => {
        const body = JSON.parse(raw.rawBody) as {
          taskId: string;
          status: string;
          progress?: number;
          output?: unknown;
          usage?: GatewayUsage;
        };
        return {
          upstreamTaskId: body.taskId,
          status: body.status as 'running',
          ...(body.progress !== undefined ? { progress: body.progress } : {}),
          ...(body.output !== undefined ? { output: body.output } : {}),
          ...(body.usage !== undefined ? { usage: body.usage } : {}),
        };
      },
    },
    errorTable: {
      rows: [
        { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
        { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
      ],
      fallback: { code: 'upstream_error', retryable: false, failover: false },
    },
  };
}

function registryOf(): DialectRegistry {
  const registry = new DialectRegistry();
  registry.register(mockDialect());
  return registry;
}

function signCallback(rawBody: string): string {
  return createHmac('sha256', CHANNEL_API_KEY).update(rawBody).digest('hex');
}

// --- seed helpers ------------------------------------------------------------------------

const VIDEO_OP: ModelOperation = {
  operation: 'video.generation',
  paradigms: ['task'],
  slow: false,
  params: [{ name: 'prompt', type: 'string', billingRelevant: false, required: true }],
};

interface Seed {
  tenantId: string;
  accountId: string;
  modelId: string;
  offeringId: string;
  channelId: string;
  saleCard: { id: string; version: number };
  costCard: { id: string; version: number };
}

async function mkSeed(o: { balance: bigint; held: bigint }): Promise<Seed> {
  const [t] = await db.insert(schema.tenant).values({ name: 'rel-e2e' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(schema.account)
    .values({ tenantId: t.id, creditBalance: o.balance, creditHeld: o.held })
    .returning();
  if (!a) throw new Error('account insert returned no row');

  const provider = await createSupplyProvider(db, {
    slug: 'rel-brand',
    name: 'Reliability Brand',
    defaultDialect: { ref: 'mock.reliability', version: 'v1' },
  });
  const channel = await createSupplyChannel(db, {
    providerId: provider.id,
    name: 'rel-ch',
    authScheme: 'bearer',
    baseUrl: 'https://up-rel.test',
  });
  await createSupplyCredential(db, {
    channelId: channel.id,
    name: 'rel-key',
    secret: { scheme: 'bearer', api_key: CHANNEL_API_KEY },
    keyB64: VAULT_KEY,
    quota: { rpm: null, tpm: null, max_concurrency: 4 },
  });
  const sale = await createSupplyPriceCard(db, {
    name: 'rel-sale',
    method: 'fixed',
    unit: 'request',
    spec: { method: 'fixed', amount: 5_000 },
  });
  const cost = await createSupplyPriceCard(db, {
    name: 'rel-cost',
    method: 'fixed',
    unit: 'request',
    spec: { method: 'fixed', amount: 1_000 },
  });
  const model = await createSupplyModel(db, {
    name: 'rel-video',
    displayName: 'Reliability Video',
    modality: 'video',
    operations: [VIDEO_OP],
    status: 'active',
    visibility: 'public',
    priceCardId: sale.id,
  });
  const offering = await createSupplyOffering(db, {
    modelId: model.id,
    channelId: channel.id,
    status: 'enabled',
    upstreamModelName: 'up-rel-video',
    fetchProfile: { mode: 'submit_poll' },
    costPriceCardId: cost.id,
  });
  return {
    tenantId: t.id,
    accountId: a.id,
    modelId: model.id,
    offeringId: offering.id,
    channelId: channel.id,
    saleCard: { id: sale.id, version: sale.version },
    costCard: { id: cost.id, version: cost.version },
  };
}

/** Insert a RUNNING task row with full settle-reconstruction columns (slice2 contract). */
async function mkRunningTask(
  seed: Seed,
  o: {
    fetchMode: 'submit_poll' | 'direct';
    upstreamTaskId?: string | null;
    ownerNode?: string | null;
    leaseUntil?: Date | null;
    holdExpiresAt: Date;
    holdAmount?: bigint;
    startedAt?: Date;
    maxRunTimeSeconds?: number;
  },
): Promise<TaskRow> {
  const saleRef: PriceCardSnapshotRef = {
    card_id: seed.saleCard.id,
    version: seed.saleCard.version,
  };
  const costRef: PriceCardSnapshotRef = {
    card_id: seed.costCard.id,
    version: seed.costCard.version,
  };
  const [row] = await db
    .insert(schema.task)
    .values({
      tenantId: seed.tenantId,
      operation: 'video.generation',
      modelId: seed.modelId,
      offeringId: seed.offeringId,
      status: 'running',
      internalSubstate: 'upstream_submitted',
      fetchMode: o.fetchMode,
      upstreamTaskId: o.upstreamTaskId ?? null,
      ownerNode: o.ownerNode ?? null,
      leaseUntil: o.leaseUntil ?? null,
      maxRunTimeSeconds: o.maxRunTimeSeconds ?? 600,
      holdExpiresAt: o.holdExpiresAt,
      holdAmount: o.holdAmount ?? 5_000n,
      accountId: seed.accountId,
      estimated: false,
      saleCardRef: saleRef,
      costCardRef: costRef,
      inputs: {
        model: 'rel-video',
        params: {},
        options: {},
        effective: { canonical: {}, upstream: {} },
        billingDims: {},
        modifiers: [],
      },
      startedAt: o.startedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('task insert returned no row');
  return row;
}

function recoveryDeps(http: ScriptHttp, ownerNode = 'rescue-node'): TaskRecoveryDeps {
  return {
    db,
    dialectRegistry: registryOf(),
    spiHttp: http,
    ownerNode,
    sleep: () => Promise.resolve(),
  };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(schema.account).where(eq(schema.account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

async function readTask(id: string): Promise<TaskRow> {
  const [t] = await db.select().from(schema.task).where(eq(schema.task.id, id));
  if (!t) throw new Error('task not found');
  return t;
}

async function settleLedgerRows(
  offeringId: string,
): Promise<(typeof schema.ledgerTxn.$inferSelect)[]> {
  return db
    .select()
    .from(schema.ledgerTxn)
    .where(
      and(
        eq(schema.ledgerTxn.type, 'settle'),
        like(schema.ledgerTxn.resourceId, `supply_offering:${offeringId}`),
      ),
    );
}

// --- 2.5-a worker kill → lease takeover completes the task -------------------------------

describe('判据 2.5-a — lease takeover after a worker death (submit_poll)', () => {
  it('claims the expired-lease task, polls to succeeded, settles once with the §9.2 dual snapshot', async () => {
    const seed = await mkSeed({ balance: 1_000_000n, held: 5_000n });
    const task = await mkRunningTask(seed, {
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-R-1',
      ownerNode: 'dead-node', // the killed worker
      leaseUntil: new Date(Date.now() - 300_000), // lease long expired
      holdExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const http = new ScriptHttp();
    http.on('GET', 'https://up-rel.test/mock/tasks/up-R-1', () => ({
      status: 200,
      body: {
        taskId: 'up-R-1',
        status: 'succeeded',
        output: { video_url: 'https://up-rel.test/v.mp4' },
        usage: { metrics: { video_seconds: 6 }, billingDims: {}, estimated: false },
      },
    }));

    const summary = await sweepRecoverableTasks(recoveryDeps(http));
    expect(summary.claimed).toBe(1);
    expect(summary.outcomes.settled).toBe(1);

    const after = await readTask(task.id);
    expect(after.status).toBe('succeeded');
    expect(after.output).toEqual({ video_url: 'https://up-rel.test/v.mp4' });
    expect(after.ownerNode).toBe('rescue-node'); // the takeover claimed it

    // §9.2: hold released + charge debited exactly once; dual snapshot on the ledger.
    const account = await readAccount(seed.accountId);
    expect(account.held).toBe(0n);
    expect(account.balance).toBe(1_000_000n - 5_000n);
    const rows = await settleLedgerRows(seed.offeringId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creditsDelta).toBe(-5_000n);
    expect(rows[0]?.pricebookVersion).toBe(seed.saleCard.version);
    const envelope = rows[0]?.modifiersApplied as {
      cost_side_credits: string | null;
      sale_card_ref: { card_id: string };
      cost_card_ref: { card_id: string };
    };
    expect(envelope.cost_side_credits).toBe('1000');
    expect(envelope.sale_card_ref.card_id).toBe(seed.saleCard.id);
    expect(envelope.cost_card_ref.card_id).toBe(seed.costCard.id);

    // Idempotent: a second sweep finds nothing to claim (terminal row).
    const again = await sweepRecoverableTasks(recoveryDeps(http));
    expect(again.claimed).toBe(0);
  }, 60_000);
});

// --- 2.5-b direct crash → failed, NO charge ----------------------------------------------

describe('判据 2.5-b — orphaned direct task fails WITHOUT charge (§3 at-most-once)', () => {
  it('reaps the orphan: failed, hold released, zero ledger charge, never re-submitted', async () => {
    const seed = await mkSeed({ balance: 1_000_000n, held: 7_000n });
    const task = await mkRunningTask(seed, {
      fetchMode: 'direct',
      upstreamTaskId: null, // direct has no upstream handle by construction
      holdExpiresAt: new Date(Date.now() - 1_000), // orphan condition
      holdAmount: 7_000n,
    });
    const http = new ScriptHttp(); // NOTHING routed — any upstream call would 404

    const reaped = await reapOrphanedDirectTasks(recoveryDeps(http), new Date());
    expect(reaped).toEqual({ scanned: 1, failed: 1 });

    const after = await readTask(task.id);
    expect(after.status).toBe('failed');
    expect(after.error?.code).toBe('task_failed');

    const account = await readAccount(seed.accountId);
    expect(account.held).toBe(0n); // hold released
    expect(account.balance).toBe(1_000_000n); // NOT charged
    expect(await settleLedgerRows(seed.offeringId)).toHaveLength(0);
    // §3 至多一次: recovery made ZERO upstream calls (no blind re-submit).
    expect(http.requests).toHaveLength(0);
  }, 60_000);
});

// --- 2.5-c a >15min slow task is NOT killed (hold TTL = max_run + buffer) -----------------

describe('判据 2.5-c — slow task past the legacy 15min is not reaped', () => {
  it('neither the hold reaper nor the takeover sweep touches a healthy long-running task at t=+16min', async () => {
    const seed = await mkSeed({ balance: 1_000_000n, held: 5_000n });
    const startedAt = new Date(Date.now() - 16 * 60_000); // 16 minutes in flight
    const task = await mkRunningTask(seed, {
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-S-1',
      ownerNode: 'healthy-node',
      leaseUntil: new Date(Date.now() + 55_000), // the owner is alive and renewing
      // §7.3: hold TTL = max_run (3600s) + buffer — NOT the legacy 15 minutes.
      holdExpiresAt: new Date(startedAt.getTime() + (3_600 + 120) * 1_000),
      maxRunTimeSeconds: 3_600,
      startedAt,
    });
    const http = new ScriptHttp(); // no routes — any probe would be visible

    const now = new Date();
    const reaped = await reapExpiredHoldGatewayTasks(recoveryDeps(http), now);
    expect(reaped).toEqual({ scanned: 0, failed: 0 });
    const swept = await sweepRecoverableTasks(recoveryDeps(http));
    expect(swept.claimed).toBe(0); // healthy lease — never taken over

    const after = await readTask(task.id);
    expect(after.status).toBe('running'); // 不被误杀
    // The decoupling in numbers: the row's TTL horizon exceeds 15 minutes.
    expect((after.holdExpiresAt?.getTime() ?? 0) - startedAt.getTime()).toBeGreaterThan(
      15 * 60_000,
    );
    expect(http.requests).toHaveLength(0);
    const account = await readAccount(seed.accountId);
    expect(account.held).toBe(5_000n); // hold intact
  }, 60_000);
});

// --- 2.5-d the upstream callback path: 验签 → 乱序 → 反查 → 去重 ---------------------------

describe('判据 2.5-d — upstream callback: verify, out-of-order tolerance, confirm-back, dedupe', () => {
  it('runs the full §3 双保险 callback chain against a real task row', async () => {
    const seed = await mkSeed({ balance: 1_000_000n, held: 5_000n });
    const task = await mkRunningTask(seed, {
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-C-1',
      ownerNode: 'api-node',
      leaseUntil: new Date(Date.now() + 55_000),
      holdExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const http = new ScriptHttp();
    // The 反查 confirmation the terminal callback triggers:
    http.on('GET', 'https://up-rel.test/mock/tasks/up-C-1', () => ({
      status: 200,
      body: {
        taskId: 'up-C-1',
        status: 'succeeded',
        output: { video_url: 'https://up-rel.test/c.mp4' },
        usage: { metrics: { video_seconds: 3 }, billingDims: {}, estimated: false },
      },
    }));
    const service = new GatewayCallbacksService(db, registryOf(), http);
    const ingest = (
      body: Record<string, unknown>,
      opts: { badSignature?: boolean } = {},
    ): Promise<Awaited<ReturnType<GatewayCallbacksService['ingest']>>> => {
      const raw = JSON.stringify(body);
      return service.ingest(
        seed.offeringId,
        Buffer.from(raw, 'utf8'),
        { 'x-mock-signature': opts.badSignature === true ? 'deadbeef' : signCallback(raw) },
        new Date(),
      );
    };

    // ── 验签: a bad signature is rejected (401) and never parsed/folded. ────
    await expect(
      ingest({ taskId: 'up-C-1', status: 'succeeded' }, { badSignature: true }),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    expect((await readTask(task.id)).status).toBe('running');

    // ── 乱序容忍 (in-flight): a progress observation folds, never fails. ────
    const progress = await ingest({ taskId: 'up-C-1', status: 'running', progress: 40 });
    expect(progress).toMatchObject({ status: 'accepted', settled: false, outcome: 'progress' });
    expect((await readTask(task.id)).progress).toBe(40);

    // ── 反查确认 + settle: the terminal callback is confirmed upstream, then
    //    settles exactly once (hold → charge). ────────────────────────────────
    const confirmsBefore = http.requests.filter((r) => r.method === 'GET').length;
    const settled = await ingest({ taskId: 'up-C-1', status: 'succeeded' });
    expect(settled).toMatchObject({ status: 'accepted', settled: true, outcome: 'settled' });
    expect(http.requests.filter((r) => r.method === 'GET').length).toBe(confirmsBefore + 1);
    const afterSettle = await readTask(task.id);
    expect(afterSettle.status).toBe('succeeded');
    expect(afterSettle.output).toEqual({ video_url: 'https://up-rel.test/c.mp4' });
    const account = await readAccount(seed.accountId);
    expect(account.held).toBe(0n);
    expect(account.balance).toBe(1_000_000n - 5_000n);
    expect(await settleLedgerRows(seed.offeringId)).toHaveLength(1);

    // ── 去重: the SAME terminal callback replayed → stale, no second charge,
    //    and NO extra upstream confirm round-trip (去重先于反查). ────────────
    const confirmsAfterSettle = http.requests.filter((r) => r.method === 'GET').length;
    const replay = await ingest({ taskId: 'up-C-1', status: 'succeeded' });
    expect(replay).toMatchObject({ status: 'accepted', settled: false, outcome: 'stale' });
    expect(http.requests.filter((r) => r.method === 'GET').length).toBe(confirmsAfterSettle);
    expect(await settleLedgerRows(seed.offeringId)).toHaveLength(1);
    expect((await readAccount(seed.accountId)).balance).toBe(1_000_000n - 5_000n);

    // ── 乱序容忍 (late): an in-flight observation AFTER the terminal write
    //    no-ops on the from-guard (stale) — it can never un-terminalize. ─────
    const late = await ingest({ taskId: 'up-C-1', status: 'running', progress: 90 });
    expect(late).toMatchObject({ settled: false, outcome: 'stale' });
    expect((await readTask(task.id)).status).toBe('succeeded');
  }, 60_000);
});

// --- §9.2 reconciliation aggregation (判据 2.6 报表可出) -----------------------------------

describe('判据 2.6 — reconciliation aggregation over real settles', () => {
  it('buckets settles per (day, tenant, offering) with sale/cost sides and degradation flags', async () => {
    const seed = await mkSeed({ balance: 1_000_000n, held: 10_000n });
    // Two running tasks; settle #1 with the full dual card, #2 without a cost
    // card (对账降级 → cost_missing).
    const t1 = await mkRunningTask(seed, {
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-M-1',
      holdExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const t2 = await mkRunningTask(seed, {
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-M-2',
      holdExpiresAt: new Date(Date.now() + 3_600_000),
    });

    const settle = (task: TaskRow, withCost: boolean) =>
      settleGatewayResult(
        { db },
        {
          tenantId: seed.tenantId,
          accountId: seed.accountId,
          wallet: { kind: 'tenant', accountId: seed.accountId, tenantId: seed.tenantId },
          holdAmount: 5_000n,
          saleCardRef: { cardId: seed.saleCard.id, version: seed.saleCard.version },
          costCardRef: withCost
            ? { cardId: seed.costCard.id, version: seed.costCard.version }
            : null,
          billingDims: {},
          modifiers: [],
          usage: { metrics: { requests: 1 }, billingDims: {}, estimated: false },
          output: { ok: true },
          task,
          offeringId: seed.offeringId,
        },
      );
    expect((await settle(t1, true)).ok).toBe(true);
    expect((await settle(t2, false)).ok).toBe(true);

    const from = new Date(Date.now() - 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    const rows = await aggregateGatewayReconciliation(db, { from, to });
    expect(rows).toHaveLength(1); // one (day, tenant, offering) bucket
    const bucket = rows[0];
    if (bucket === undefined) throw new Error('no reconciliation bucket');
    expect(bucket.tenantId).toBe(seed.tenantId);
    expect(bucket.offeringId).toBe(seed.offeringId);
    expect(bucket.channelId).toBe(seed.channelId);
    expect(bucket.providerSlug).toBe('rel-brand');
    expect(bucket.modelName).toBe('rel-video');
    expect(bucket.settleCount).toBe(2);
    expect(bucket.estimatedCount).toBe(0);
    expect(bucket.costMissingCount).toBe(1); // the cost-less settle is FLAGGED
    expect(bucket.saleSideCredits).toBe(10_000n); // 2 × 5000 sale side
    expect(bucket.costSideCredits).toBe(1_000n); // only settle #1 carried cost

    // The wire report (admin GET) math: totals + margin.
    const report = renderReport(from, to, rows);
    expect(report.totals).toEqual({
      settle_count: 2,
      estimated_count: 0,
      cost_missing_count: 1,
      sale_side_credits: '10000',
      cost_side_credits: '1000',
      gross_margin_credits: '9000',
    });
    expect(report.rows[0]?.gross_margin_credits).toBe('9000');

    // Tenant scoping: an unrelated tenant window is empty.
    const scoped = await aggregateGatewayReconciliation(db, {
      from,
      to,
      tenantId: '00000000-0000-0000-0000-000000000000',
    });
    expect(scoped).toHaveLength(0);
  }, 60_000);
});
