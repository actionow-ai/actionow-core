import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  appendTaskEvent,
  claimTaskIdempotency,
  claimTaskLease,
  clipTaskEventPayload,
  createTask,
  type CreateTaskInput,
  createWebhookDelivery,
  deleteTaskEventsOlderThan,
  getTaskByIdForTenant,
  getTaskByUpstreamTaskIdForOffering,
  getTenantWebhookSecret,
  listDueWebhookDeliveries,
  listExpiredHoldGatewayTasks,
  listOrphanedDirectTasks,
  listRecoverableTasksForTakeover,
  listTaskEvents,
  listTasks,
  markWebhookDeliverySent,
  renewTaskLease,
  TASK_EVENT_PAYLOAD_MAX_BYTES,
  transitionTask,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

/** Assert a fixture row (drizzle `.returning()` / index access is `T | undefined`) is present. */
function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined fixture row');
  return value;
}

// 批次4 slice1 — task-center data layer against REAL Postgres: the §5
// idempotency backstop (ON CONFLICT on the partial unique index), the guarded
// transition + inline task_events append (§7.1), the mig 0071 append-only
// trigger semantics (UPDATE blocked / retention DELETE allowed), §7.2 lease
// claim/renew/takeover, and §7.6 webhook-delivery idempotent enqueue.

const {
  apiKey,
  supplyChannel,
  supplyModel,
  supplyOffering,
  supplyProvider,
  task,
  taskEvents,
  tenant,
} = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let tenantId: string;
let apiKeyId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });

  const tenants = await db.insert(tenant).values({ name: 'task-int' }).returning();
  tenantId = req(tenants[0]).id;
  const keys = await db.insert(apiKey).values({ tenantId, hash: 'h_task_int' }).returning();
  apiKeyId = req(keys[0]).id;
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  // TRUNCATE fires no row triggers, so the append-only trigger permits cleanup.
  await client`TRUNCATE TABLE webhook_deliveries, task_events, task CASCADE`;
});

function baseInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    tenantId,
    apiKeyId,
    operation: 'video.generation',
    inputs: { prompt: 'a teapot orbiting the moon' },
    ...overrides,
  };
}

describe('createTask + idempotency (§5)', () => {
  it('creates a pending task', async () => {
    const { task: row, created } = await createTask(db, baseInput());
    expect(created).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.estimated).toBe(false);
    expect(await getTaskByIdForTenant(db, row.id, tenantId)).toBeDefined();
  });

  it('same (tenant, key, idempotency_key) returns the EXISTING task, created:false', async () => {
    const first = await createTask(
      db,
      baseInput({ idempotencyKey: 'idem-1', requestFingerprint: 'fp-a' }),
    );
    const second = await createTask(
      db,
      baseInput({ idempotencyKey: 'idem-1', requestFingerprint: 'fp-b' }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('claimTaskIdempotency reports fingerprint match vs conflict', async () => {
    const fresh = await claimTaskIdempotency(db, {
      tenantId,
      apiKeyId,
      idempotencyKey: 'idem-2',
      fingerprint: 'fp-a',
    });
    expect(fresh.claimed).toBe(true);

    await createTask(db, baseInput({ idempotencyKey: 'idem-2', requestFingerprint: 'fp-a' }));
    const replay = await claimTaskIdempotency(db, {
      tenantId,
      apiKeyId,
      idempotencyKey: 'idem-2',
      fingerprint: 'fp-a',
    });
    expect(replay).toMatchObject({ claimed: false, fingerprintMatch: true });

    const conflict = await claimTaskIdempotency(db, {
      tenantId,
      apiKeyId,
      idempotencyKey: 'idem-2',
      fingerprint: 'fp-DIFFERENT',
    });
    expect(conflict).toMatchObject({ claimed: false, fingerprintMatch: false });
  });
});

describe('transitionTask + task_events (§7.1)', () => {
  it('moves pending→running, writes extras, appends event seq 1 with exact from_status', async () => {
    const { task: row } = await createTask(db, baseInput());
    const moved = await transitionTask(db, row.id, ['pending'], 'running', {
      fetchMode: 'submit_poll',
      upstreamTaskId: 'up-123',
      progress: 5,
      startedAt: new Date(),
      eventPayload: { note: 'submitted' },
    });
    expect(moved?.status).toBe('running');
    expect(moved?.upstreamTaskId).toBe('up-123');

    const events = await listTaskEvents(db, row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      fromStatus: 'pending',
      toStatus: 'running',
      payload: { note: 'submitted' },
    });
  });

  it('from-guard: a mismatched source moves nothing and appends no event', async () => {
    const { task: row } = await createTask(db, baseInput());
    const moved = await transitionTask(db, row.id, ['running'], 'succeeded');
    expect(moved).toBeUndefined();
    expect(await listTaskEvents(db, row.id)).toHaveLength(0);
  });

  it('terminal states are frozen: cannot be a source (throws) and a second settle no-ops', async () => {
    const { task: row } = await createTask(db, baseInput());
    await transitionTask(db, row.id, ['pending'], 'running');
    await transitionTask(db, row.id, ['running'], 'succeeded');
    // Repo-level 终态禁迁移: terminal sources are rejected up front.
    await expect(transitionTask(db, row.id, ['succeeded'], 'running')).rejects.toThrow(/terminal/);
    // And a stale caller guarded on non-terminal sources finds no row.
    expect(await transitionTask(db, row.id, ['pending', 'running'], 'canceled')).toBeUndefined();
    expect(await listTaskEvents(db, row.id)).toHaveLength(2);
  });

  it('appendTaskEvent seqs are per-task monotonic; oversized payloads are clipped ≤4KB', async () => {
    const { task: row } = await createTask(db, baseInput());
    await appendTaskEvent(db, { taskId: row.id, fromStatus: null, toStatus: 'pending' });
    const big = await appendTaskEvent(db, {
      taskId: row.id,
      fromStatus: 'pending',
      toStatus: 'running',
      payload: { raw: 'x'.repeat(20_000) },
    });
    expect(big.seq).toBe(2);
    const stored = big.payload as { _truncated: boolean; _original_bytes: number; _head: string };
    expect(stored._truncated).toBe(true);
    expect(stored._original_bytes).toBeGreaterThan(TASK_EVENT_PAYLOAD_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(stored), 'utf8')).toBeLessThanOrEqual(
      TASK_EVENT_PAYLOAD_MAX_BYTES,
    );
  });

  it('mig 0071 trigger: task_events UPDATE is rejected, retention DELETE is allowed', async () => {
    const { task: row } = await createTask(db, baseInput());
    await appendTaskEvent(db, { taskId: row.id, fromStatus: null, toStatus: 'pending' });
    // Drizzle wraps the PG error ("Failed query: …") — the trigger's message
    // rides the cause chain, so assert on it there.
    const failure = await db
      .update(taskEvents)
      .set({ toStatus: 'succeeded' })
      .where(eq(taskEvents.taskId, row.id))
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(failure).toBeDefined();
    expect(String((failure as Error & { cause?: unknown }).cause)).toMatch(/append-only/);
    // The row survived the rejected UPDATE untouched.
    expect((await listTaskEvents(db, row.id))[0]?.toStatus).toBe('pending');

    const removed = await deleteTaskEventsOlderThan(db, new Date(Date.now() + 60_000), 2);
    expect(removed).toBe(1);
    expect(await listTaskEvents(db, row.id)).toHaveLength(0);
  });
});

describe('lease (§7.2)', () => {
  async function runningTask(
    fetchMode: string | null,
    leaseUntil: Date | null,
    owner: string | null,
  ) {
    const { task: row } = await createTask(db, baseInput());
    await db
      .update(task)
      .set({ status: 'running', fetchMode, leaseUntil, ownerNode: owner })
      .where(eq(task.id, row.id));
    return row.id;
  }

  it('claim: unowned running task is claimable once; a live lease blocks other nodes', async () => {
    const id = await runningTask('submit_poll', null, null);
    const future = new Date(Date.now() + 60_000);
    expect(await claimTaskLease(db, id, 'node-a', future)).toBe(true);
    expect(await claimTaskLease(db, id, 'node-b', future)).toBe(false);
    // Re-assert by the current owner is allowed.
    expect(await claimTaskLease(db, id, 'node-a', future)).toBe(true);
  });

  it('renew: only the owner extends', async () => {
    const id = await runningTask('submit_poll', new Date(Date.now() + 10_000), 'node-a');
    expect(await renewTaskLease(db, id, 'node-a', new Date(Date.now() + 60_000))).toBe(true);
    expect(await renewTaskLease(db, id, 'node-b', new Date(Date.now() + 60_000))).toBe(false);
  });

  it('takeover feed: expired/never-leased RECOVERABLE running tasks only', async () => {
    const now = new Date();
    const expired = await runningTask('submit_poll', new Date(now.getTime() - 1000), 'node-x');
    const never = await runningTask('submit_callback', null, null);
    await runningTask('submit_poll', new Date(now.getTime() + 60_000), 'node-y'); // live lease
    await runningTask('direct', new Date(now.getTime() - 1000), 'node-z'); // at-most-once (§3)
    const { task: pending } = await createTask(db, baseInput()); // not running
    void pending;

    const rows = await listRecoverableTasksForTakeover(db, now);
    expect(rows.map((r) => r.id).sort()).toEqual([expired, never].sort());
    // NULLS FIRST: the never-leased orphan surfaces before the expired lease.
    expect(rows[0]?.id).toBe(never);
  });
});

describe('getTaskByUpstreamTaskIdForOffering — FIX2 offering-scoped callback correlation', () => {
  it('two offerings sharing ONE upstream handle correlate independently (no cross-talk)', async () => {
    // Supply skeleton: one provider, two channels, one model → two offerings
    // (UNIQUE(model, channel) forces distinct channels).
    const [prov] = await db
      .insert(supplyProvider)
      .values({
        slug: 'cb-corr',
        name: 'CB Corr',
        defaultDialect: { ref: 'mock.dialect', version: 'v1' },
      })
      .returning();
    const [chanA] = await db
      .insert(supplyChannel)
      .values({ providerId: req(prov).id, name: 'cb-corr-A', authScheme: 'bearer' })
      .returning();
    const [chanB] = await db
      .insert(supplyChannel)
      .values({ providerId: req(prov).id, name: 'cb-corr-B', authScheme: 'bearer' })
      .returning();
    const [model] = await db
      .insert(supplyModel)
      .values({ name: 'cb-corr-model', displayName: 'CB Corr', modality: 'video', operations: [] })
      .returning();
    const [offA] = await db
      .insert(supplyOffering)
      .values({
        modelId: req(model).id,
        channelId: req(chanA).id,
        upstreamModelName: 'up-m',
        fetchProfile: { mode: 'submit_callback' },
      })
      .returning();
    const [offB] = await db
      .insert(supplyOffering)
      .values({
        modelId: req(model).id,
        channelId: req(chanB).id,
        upstreamModelName: 'up-m',
        fetchProfile: { mode: 'submit_callback' },
      })
      .returning();

    // Both vendor accounts handed out the SAME task handle 'job-100'.
    const a = await createTask(
      db,
      baseInput({ offeringId: req(offA).id, upstreamTaskId: 'job-100' }),
    );
    const b = await createTask(
      db,
      baseInput({ offeringId: req(offB).id, upstreamTaskId: 'job-100' }),
    );

    const forA = await getTaskByUpstreamTaskIdForOffering(db, 'job-100', req(offA).id);
    const forB = await getTaskByUpstreamTaskIdForOffering(db, 'job-100', req(offB).id);
    expect(forA?.id).toBe(a.task.id);
    // Offering B's callback hits B's task — the global LIMIT-1 lookup could
    // answer A's row here (unordered) and 误拒 or cross-settle.
    expect(forB?.id).toBe(b.task.id);

    // An offering with no such handle correlates to NOTHING (→ 404 upstream retry).
    expect(
      await getTaskByUpstreamTaskIdForOffering(
        db,
        'job-100',
        '00000000-0000-0000-0000-000000000000',
      ),
    ).toBeUndefined();

    // Soft-deleted rows are invisible to correlation.
    await db.update(task).set({ deletedAt: new Date() }).where(eq(task.id, b.task.id));
    expect(await getTaskByUpstreamTaskIdForOffering(db, 'job-100', req(offB).id)).toBeUndefined();
  });
});

describe('orphan/expiry sweeps (§3 direct 至多一次 / §7.3 backstop — slice4)', () => {
  async function heldTask(o: {
    status?: string;
    fetchMode: string | null;
    holdExpiresAt: Date | null;
  }) {
    const { task: row } = await createTask(db, baseInput());
    await db
      .update(task)
      .set({
        status: o.status ?? 'running',
        fetchMode: o.fetchMode,
        holdExpiresAt: o.holdExpiresAt,
      })
      .where(eq(task.id, row.id));
    return row.id;
  }

  it('listOrphanedDirectTasks: running ∩ direct ∩ hold expired ONLY', async () => {
    const now = new Date();
    const orphan = await heldTask({
      fetchMode: 'direct',
      holdExpiresAt: new Date(now.getTime() - 1000),
    });
    await heldTask({ fetchMode: 'direct', holdExpiresAt: new Date(now.getTime() + 60_000) }); // in budget
    await heldTask({ fetchMode: 'submit_poll', holdExpiresAt: new Date(now.getTime() - 1000) }); // not direct
    await heldTask({ fetchMode: 'direct', holdExpiresAt: null }); // no hold TTL recorded

    const rows = await listOrphanedDirectTasks(db, now);
    expect(rows.map((r) => r.id)).toEqual([orphan]);
  });

  it('listExpiredHoldGatewayTasks: live NON-direct rows past hold expiry (pending crash orphan included)', async () => {
    const now = new Date();
    const poll = await heldTask({
      fetchMode: 'submit_poll',
      holdExpiresAt: new Date(now.getTime() - 1000),
    });
    const stuckPending = await heldTask({
      status: 'pending',
      fetchMode: null,
      holdExpiresAt: new Date(now.getTime() - 1000),
    });
    await heldTask({ fetchMode: 'direct', holdExpiresAt: new Date(now.getTime() - 1000) }); // direct arm's
    await heldTask({
      fetchMode: 'submit_callback',
      holdExpiresAt: new Date(now.getTime() + 60_000),
    }); // live

    const rows = await listExpiredHoldGatewayTasks(db, now);
    expect(rows.map((r) => r.id).sort()).toEqual([poll, stuckPending].sort());
  });
});

describe('getTenantWebhookSecret (§7.6 tenant-level config)', () => {
  it('reads config.webhook_secret; absent/blank → undefined', async () => {
    expect(await getTenantWebhookSecret(db, tenantId)).toBeUndefined();
    await db
      .update(tenant)
      .set({ config: { webhook_secret: 'whsec_t1' } })
      .where(eq(tenant.id, tenantId));
    expect(await getTenantWebhookSecret(db, tenantId)).toBe('whsec_t1');
    await db
      .update(tenant)
      .set({ config: { webhook_secret: '' } })
      .where(eq(tenant.id, tenantId));
    expect(await getTenantWebhookSecret(db, tenantId)).toBeUndefined();
    await db.update(tenant).set({ config: {} }).where(eq(tenant.id, tenantId));
  });
});

describe('webhook_deliveries (§7.6)', () => {
  it('enqueue is idempotent on (task_id, evt_id); due-list and state moves work', async () => {
    const { task: row } = await createTask(db, baseInput());
    const input = {
      taskId: row.id,
      evtId: 'evt_1',
      eventType: 'task.succeeded',
      url: 'https://example.test/hook',
      payload: { evt_id: 'evt_1', type: 'task.succeeded' },
      signature: 't=1,v1=abc',
    };
    const first = await createWebhookDelivery(db, input);
    expect(first?.status).toBe('pending');
    // Duplicate enqueue = already queued, not an error.
    expect(await createWebhookDelivery(db, input)).toBeUndefined();

    const due = await listDueWebhookDeliveries(db, new Date());
    expect(due).toHaveLength(1);
    await markWebhookDeliverySent(db, req(first).id, 1);
    expect(await listDueWebhookDeliveries(db, new Date())).toHaveLength(0);
  });
});

describe('listTasks (keyset)', () => {
  it('filters by status/operation and pages newest-first', async () => {
    await createTask(db, baseInput({ operation: 'tts' }));
    const { task: v } = await createTask(db, baseInput());
    await transitionTask(db, v.id, ['pending'], 'running');

    const running = await listTasks(db, { tenantId, status: 'running' }, { limit: 10 });
    expect(running.rows.map((r) => r.id)).toEqual([v.id]);
    const tts = await listTasks(db, { tenantId, operation: 'tts' }, { limit: 10 });
    expect(tts.rows).toHaveLength(1);
    const page1 = await listTasks(db, { tenantId }, { limit: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
  });
});

describe('clipTaskEventPayload', () => {
  it('passes small payloads through verbatim and nulls empty ones', () => {
    expect(clipTaskEventPayload({ a: 1 })).toEqual({ a: 1 });
    expect(clipTaskEventPayload(null)).toBeNull();
    expect(clipTaskEventPayload(undefined)).toBeNull();
  });
});
