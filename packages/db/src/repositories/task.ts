import type { TaskStatus } from '@actionow/contracts';
import { TERMINAL_TASK_STATUSES } from '@actionow/contracts';
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';

import { task, taskEvents, tenant, webhookDeliveries } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

// model-supply-greenfield 批次4 slice1 — task-center repositories (design §7):
// task lifecycle (create / guarded transition + inline event append / list),
// §5 idempotency claim, §7.2 lease renewal/takeover, §7.6 webhook delivery
// records, and the §9.3 task_events retention sweep.

export type TaskRow = InferSelectModel<typeof task>;
export type TaskEventRow = InferSelectModel<typeof taskEvents>;
export type WebhookDeliveryRow = InferSelectModel<typeof webhookDeliveries>;

/** The frozen terminal set, widened once for `includes` checks. */
const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

// --- task_events payload clipping (§7.1: 裁剪至 4KB) ---------------------------

/** Hard cap on a stored task_events payload's serialized size (§7.1). */
export const TASK_EVENT_PAYLOAD_MAX_BYTES = 4096;

/**
 * Clip an event payload to ≤ {@link TASK_EVENT_PAYLOAD_MAX_BYTES} of serialized
 * JSON (§7.1 上游 raw 超限截断). A payload within budget is stored verbatim; an
 * oversized one is replaced by a truncation envelope `{_truncated, _original_bytes,
 * _head}` whose `_head` (a prefix of the original JSON text) is halved until the
 * envelope itself fits — deterministic and always within the cap.
 */
export function clipTaskEventPayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return null;
  // `JSON.stringify` is TYPED `string` but really yields undefined for bare
  // functions/symbols — assert the honest type so the guard is allowed.
  const json = JSON.stringify(payload) as string | undefined;
  if (json === undefined) return null;
  if (Buffer.byteLength(json, 'utf8') <= TASK_EVENT_PAYLOAD_MAX_BYTES) return payload;
  let head = json.slice(0, 3200);
  for (;;) {
    const wrapped = {
      _truncated: true,
      _original_bytes: Buffer.byteLength(json, 'utf8'),
      _head: head,
    };
    if (Buffer.byteLength(JSON.stringify(wrapped), 'utf8') <= TASK_EVENT_PAYLOAD_MAX_BYTES) {
      return wrapped;
    }
    if (head.length === 0) return { _truncated: true, _original_bytes: json.length, _head: '' };
    head = head.slice(0, Math.floor(head.length / 2));
  }
}

// --- create + idempotency claim (§5) -------------------------------------------

/**
 * Fields a caller supplies to {@link createTask}. `status` (forced `pending`),
 * timestamps and soft-delete are DB/repo-managed; `id` is optional for callers
 * that must reference it before insert.
 */
export type CreateTaskInput = Omit<
  InferInsertModel<typeof task>,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt' | 'deletedAt'
> & { id?: string };

/** `created: false` ⇒ `task` is a PRE-EXISTING row won by the idempotency backstop, not a new insert. */
export interface CreateTaskResult {
  task: TaskRow;
  created: boolean;
}

/**
 * Insert a `task` in status `pending` (§7.4 先落库再调上游 step 1). When the
 * input carries an `idempotencyKey`, the insert targets the partial unique
 * index `(tenant_id, api_key_id, idempotency_key) WHERE idempotency_key IS NOT
 * NULL AND deleted_at IS NULL` with `ON CONFLICT DO NOTHING` — the RACE-SAFE
 * claim: a concurrent duplicate loses the insert and gets `{created:false,
 * task: existing}` back, so the caller can run the §5 fingerprint judgment
 * (same body → replay the existing task; different body → 409 conflict).
 * {@link claimTaskIdempotency} is the cheap pre-check; THIS conflict target is
 * the backstop.
 */
export async function createTask(db: DbOrTx, input: CreateTaskInput): Promise<CreateTaskResult> {
  const values = { ...input, status: 'pending' as const };
  if (input.idempotencyKey == null) {
    const rows = await db.insert(task).values(values).returning();
    const row = rows[0];
    if (!row) throw new Error('createTask: insert returned no row');
    return { task: row, created: true };
  }

  const inserted = await db
    .insert(task)
    .values(values)
    .onConflictDoNothing({
      target: [task.tenantId, task.apiKeyId, task.idempotencyKey],
      where: sql`idempotency_key IS NOT NULL AND deleted_at IS NULL`,
    })
    .returning();
  const row = inserted[0];
  if (row) return { task: row, created: true };

  const existing = await selectByIdempotencyKey(
    db,
    input.tenantId,
    input.apiKeyId ?? null,
    input.idempotencyKey,
  );
  if (!existing) {
    // The conflicting row vanished between INSERT and SELECT (concurrent soft
    // delete). Surface it rather than silently returning a bad result.
    throw new Error(
      `createTask: idempotency conflict on (${input.tenantId}, ${input.idempotencyKey}) but no existing row`,
    );
  }
  return { task: existing, created: false };
}

async function selectByIdempotencyKey(
  db: DbOrTx,
  tenantId: string,
  apiKeyId: string | null,
  idempotencyKey: string,
): Promise<TaskRow | undefined> {
  const rows = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.tenantId, tenantId),
        apiKeyId === null ? isNull(task.apiKeyId) : eq(task.apiKeyId, apiKeyId),
        eq(task.idempotencyKey, idempotencyKey),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/** The §5 idempotency judgment inputs: scope = (tenant, key) per §2.6. */
export interface ClaimTaskIdempotencyInput {
  tenantId: string;
  apiKeyId: string;
  idempotencyKey: string;
  /** Fingerprint (hash) of the canonical request body. */
  fingerprint: string;
}

export type ClaimTaskIdempotencyResult =
  | { claimed: true }
  | {
      claimed: false;
      existing: TaskRow;
      /** `true` → same key + same body ⇒ replay `existing`; `false` ⇒ 409 conflict (§5). */
      fingerprintMatch: boolean;
    };

/**
 * Fast-path idempotency pre-check (§5): look up a LIVE task claiming
 * `(tenant, api_key, idempotency_key)`. `{claimed:true}` means no claimant was
 * visible — the caller proceeds to {@link createTask}, whose `ON CONFLICT`
 * backstop resolves any race. On `{claimed:false}` the caller maps
 * `fingerprintMatch` to replay (true) vs 409 `conflict` (false).
 */
export async function claimTaskIdempotency(
  db: DbOrTx,
  input: ClaimTaskIdempotencyInput,
): Promise<ClaimTaskIdempotencyResult> {
  const existing = await selectByIdempotencyKey(
    db,
    input.tenantId,
    input.apiKeyId,
    input.idempotencyKey,
  );
  if (!existing) return { claimed: true };
  return {
    claimed: false,
    existing,
    fingerprintMatch:
      existing.requestFingerprint !== null && existing.requestFingerprint === input.fingerprint,
  };
}

// --- reads ----------------------------------------------------------------------

/** Fetch a task by id (internal path — no tenant/soft-delete filter), or `undefined`. */
export async function getTaskById(db: DbOrTx, taskId: string): Promise<TaskRow | undefined> {
  const rows = await db.select().from(task).where(eq(task.id, taskId)).limit(1);
  return rows[0];
}

/** Tenant-isolated read (external GET /v1/tasks/:id): soft-deleted rows are invisible (→ 404). */
export async function getTaskByIdForTenant(
  db: DbOrTx,
  taskId: string,
  tenantId: string,
): Promise<TaskRow | undefined> {
  const rows = await db
    .select()
    .from(task)
    .where(and(eq(task.id, taskId), eq(task.tenantId, tenantId), isNull(task.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Fetch the task holding an upstream handle (callback correlation), or `undefined`. */
export async function getTaskByUpstreamTaskId(
  db: DbOrTx,
  upstreamTaskId: string,
): Promise<TaskRow | undefined> {
  const rows = await db
    .select()
    .from(task)
    .where(and(eq(task.upstreamTaskId, upstreamTaskId), isNull(task.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * OFFERING-SCOPED callback correlation (§3 去重/关联): upstream task handles
 * are only unique within one vendor account's namespace, so the SAME handle
 * may legitimately exist under DIFFERENT offerings. The callback ingress
 * already holds the VERIFIED offering (the route pins it before any byte of
 * the body is trusted) — correlating inside that offering makes the lookup
 * deterministic where the global LIMIT-1 variant would pick an arbitrary row
 * on a cross-offering collision (legit callback 误拒, or worse, the wrong
 * task observed). Newest row wins if in-offering duplicates ever exist
 * (defensive tiebreak — the live-handle invariant makes that a drift case).
 */
export async function getTaskByUpstreamTaskIdForOffering(
  db: DbOrTx,
  upstreamTaskId: string,
  offeringId: string,
): Promise<TaskRow | undefined> {
  const rows = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.upstreamTaskId, upstreamTaskId),
        eq(task.offeringId, offeringId),
        isNull(task.deletedAt),
      ),
    )
    .orderBy(desc(task.createdAt))
    .limit(1);
  return rows[0];
}

/** Filters for {@link listTasks}; each present field narrows the tenant's list. */
export interface ListTasksFilter {
  tenantId: string;
  apiKeyId?: string | undefined;
  subjectId?: string | undefined;
  status?: TaskStatus | undefined;
  /** The operation surface (external `?type=` maps here). */
  operation?: string | undefined;
}

/** List a tenant's live tasks newest-first, keyset-paginated on `(created_at, id)`. */
export async function listTasks(
  db: DbOrTx,
  filter: ListTasksFilter,
  page: PageParams,
): Promise<KeysetResult<TaskRow>> {
  const predicates: SQL[] = [eq(task.tenantId, filter.tenantId), isNull(task.deletedAt)];
  if (filter.apiKeyId !== undefined) predicates.push(eq(task.apiKeyId, filter.apiKeyId));
  if (filter.subjectId !== undefined) predicates.push(eq(task.subjectId, filter.subjectId));
  if (filter.status !== undefined) predicates.push(eq(task.status, filter.status));
  if (filter.operation !== undefined) predicates.push(eq(task.operation, filter.operation));
  return keysetPage<TaskRow>(db, {
    table: task,
    createdAtCol: task.createdAt,
    idCol: task.id,
    where: and(...predicates),
    page,
  });
}

// --- guarded transition + inline event (§7.1 / §4.3.1) ----------------------------

/**
 * Row fields a transition may set atomically alongside the status move, plus an
 * optional `eventPayload` recorded on the appended task_events row (NOT a task
 * column; repo-clipped to 4KB).
 */
export type TransitionTaskExtra = Partial<
  Pick<
    TaskRow,
    | 'internalSubstate'
    | 'progress'
    | 'fetchMode'
    | 'upstreamTaskId'
    | 'offeringId'
    | 'ownerNode'
    | 'leaseUntil'
    | 'maxRunTimeSeconds'
    | 'holdExpiresAt'
    | 'holdAmount'
    | 'accountId'
    | 'subAccountId'
    | 'estimated'
    | 'saleCardRef'
    | 'costCardRef'
    | 'artifactMode'
    | 'artifactExpiresAt'
    | 'output'
    | 'usage'
    | 'error'
    | 'startedAt'
    | 'finishedAt'
  >
> & { eventPayload?: unknown };

/**
 * Guarded state transition + INLINE event append, in ONE transaction (§4.3.1
 * 「先写 tasks + task_events 再副作用」— the two writes commit or roll back
 * together; on an outer tx this nests as a savepoint, the {@link settleJob}
 * precedent). Inside the tx:
 *
 * 1. `SELECT status … FOR UPDATE` locks the row and captures the EXACT
 *    pre-transition status (the event's `from_status`, precise even with a
 *    multi-state `from` guard) — the lock also serializes seq assignment.
 * 2. From-guard: not found / soft-deleted / status ∉ `from` → `undefined`, no
 *    write, no event. Terminal states never appear in `from` (they are
 *    rejected up front), so 终态禁迁移 holds by construction (§7.1).
 * 3. `UPDATE … SET {extra, status, updated_at} RETURNING *`.
 * 4. {@link appendTaskEvent} with the captured `from_status` + clipped payload.
 */
export async function transitionTask(
  db: DbOrTx,
  taskId: string,
  from: readonly TaskStatus[],
  to: TaskStatus,
  extra: TransitionTaskExtra = {},
): Promise<TaskRow | undefined> {
  if (from.length === 0) throw new Error('transitionTask: empty from-guard');
  const terminal = from.find((s) => TERMINAL.includes(s));
  if (terminal !== undefined) {
    throw new Error(`transitionTask: terminal status '${terminal}' cannot be a transition source`);
  }
  const { eventPayload, ...columns } = extra;
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ status: task.status })
      .from(task)
      .where(and(eq(task.id, taskId), isNull(task.deletedAt)))
      .limit(1)
      .for('update');
    const current = locked[0];
    if (!current || !(from as readonly string[]).includes(current.status)) return undefined;

    const rows = await tx
      .update(task)
      .set({ ...columns, status: to, updatedAt: sql`now()` })
      .where(eq(task.id, taskId))
      .returning();
    const row = rows[0];
    if (!row) return undefined;

    await appendTaskEvent(tx, {
      taskId,
      fromStatus: current.status as TaskStatus,
      toStatus: to,
      payload: eventPayload,
    });
    return row;
  });
}

/** Inputs to {@link appendTaskEvent}. `fromStatus: null` marks the birth event (creation → pending). */
export interface AppendTaskEventInput {
  taskId: string;
  fromStatus?: TaskStatus | null | undefined;
  toStatus: TaskStatus;
  payload?: unknown;
}

/**
 * Append one task_events row with the next per-task `seq` (§7.1). The seq is
 * computed IN the insert (`coalesce(max(seq),0)+1` subquery); a concurrent
 * appender racing to the same seq hits the `(task_id, seq)` unique index —
 * handled via `ON CONFLICT DO NOTHING` + recompute-retry (no thrown 23505, so
 * an enclosing transaction is never poisoned). Calls from
 * {@link transitionTask} are already serialized by its row lock and take the
 * first attempt. Payload is clipped to 4KB ({@link clipTaskEventPayload}).
 */
export async function appendTaskEvent(
  db: DbOrTx,
  input: AppendTaskEventInput,
): Promise<TaskEventRow> {
  const payload = clipTaskEventPayload(input.payload);
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = await db
      .insert(taskEvents)
      .values({
        taskId: input.taskId,
        seq: sql`(SELECT COALESCE(MAX(${taskEvents.seq}), 0) + 1 FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${input.taskId})`,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus,
        payload,
      })
      .onConflictDoNothing({ target: [taskEvents.taskId, taskEvents.seq] })
      .returning();
    const row = rows[0];
    if (row) return row;
  }
  throw new Error(
    `appendTaskEvent: seq contention on task ${input.taskId} after ${String(MAX_ATTEMPTS)} attempts`,
  );
}

/** List a task's event stream in seq order (audit / SSE catch-up reads). */
export async function listTaskEvents(
  db: DbOrTx,
  taskId: string,
  afterSeq = 0,
): Promise<TaskEventRow[]> {
  return db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), sql`${taskEvents.seq} > ${afterSeq}`))
    .orderBy(asc(taskEvents.seq));
}

// --- lease (§7.2 — recoverable fetch modes only) -----------------------------------

/**
 * Renew a held lease: `UPDATE … WHERE id AND owner_node = ownerNode` — only the
 * CURRENT owner can extend (§7.2 周期续租). Returns `true` iff renewed; `false`
 * means the lease was lost (another node took over) and the caller must STOP
 * driving this task.
 */
export async function renewTaskLease(
  db: DbOrTx,
  taskId: string,
  ownerNode: string,
  leaseUntil: Date,
): Promise<boolean> {
  const rows = await db
    .update(task)
    .set({ leaseUntil, updatedAt: sql`now()` })
    .where(and(eq(task.id, taskId), eq(task.ownerNode, ownerNode)))
    .returning({ id: task.id });
  return rows.length === 1;
}

/**
 * Atomically take over (or re-assert) a lease: succeeds iff the task is still
 * `running` AND unowned / expired / already ours. Exactly one contender wins —
 * the row-level UPDATE lock serializes racers, and the loser's re-evaluated
 * predicate no longer matches (lease_until now in the future).
 */
export async function claimTaskLease(
  db: DbOrTx,
  taskId: string,
  ownerNode: string,
  leaseUntil: Date,
): Promise<boolean> {
  const rows = await db
    .update(task)
    .set({ ownerNode, leaseUntil, updatedAt: sql`now()` })
    .where(
      and(
        eq(task.id, taskId),
        eq(task.status, 'running'),
        isNull(task.deletedAt),
        or(isNull(task.ownerNode), eq(task.ownerNode, ownerNode), lt(task.leaseUntil, sql`now()`)),
      ),
    )
    .returning({ id: task.id });
  return rows.length === 1;
}

/**
 * The lease-takeover sweep feed (§7.2): `running` tasks in a RECOVERABLE fetch
 * mode (`submit_poll` / `submit_callback` — `direct` is at-most-once per §3)
 * whose lease is expired or missing. Oldest/never-leased first (NULLS FIRST) so
 * the most orphaned work recovers soonest; the sweeper then races
 * {@link claimTaskLease} per row.
 */
export async function listRecoverableTasksForTakeover(
  db: DbOrTx,
  now: Date,
  limit = 50,
): Promise<TaskRow[]> {
  return db
    .select()
    .from(task)
    .where(
      and(
        eq(task.status, 'running'),
        inArray(task.fetchMode, ['submit_poll', 'submit_callback']),
        isNull(task.deletedAt),
        or(isNull(task.leaseUntil), lt(task.leaseUntil, now)),
      ),
    )
    .orderBy(sql`${task.leaseUntil} ASC NULLS FIRST`)
    .limit(limit);
}

/**
 * The §3 at-most-once orphan feed (slice2 handoff → slice4 sweep): `running`
 * tasks in fetch mode `direct` whose hold has expired. A `direct` task carries
 * NO upstream handle and is never leased — a crash mid-flight leaves the row
 * `running` until `hold_expires_at` lapses, at which point the sweep FAILS it
 * without charge (§3: 崩溃接管后直接置 failed 且不扣费, upstream cost
 * platform-absorbed) and MUST NEVER re-submit or take it over to keep driving.
 */
export async function listOrphanedDirectTasks(
  db: DbOrTx,
  now: Date,
  limit = 100,
): Promise<TaskRow[]> {
  return db
    .select()
    .from(task)
    .where(
      and(
        eq(task.status, 'running'),
        eq(task.fetchMode, 'direct'),
        isNull(task.deletedAt),
        isNotNull(task.holdExpiresAt),
        lt(task.holdExpiresAt, now),
      ),
    )
    .orderBy(asc(task.holdExpiresAt))
    .limit(limit);
}

/**
 * The §7.3 hold-expiry backstop feed for every NON-direct gateway task: live
 * (`pending`/`running`) rows whose `hold_expires_at` lapsed — a submit_poll /
 * submit_callback task nobody took over past its budget, a pending row whose
 * dispatcher crashed between insert and transition, a stream row abandoned
 * mid-drain. The sweep FAILS each (hold released, no charge); `direct` rows
 * are excluded here because {@link listOrphanedDirectTasks} owns that arm
 * (distinct §3 semantics + error message).
 */
export async function listExpiredHoldGatewayTasks(
  db: DbOrTx,
  now: Date,
  limit = 100,
): Promise<TaskRow[]> {
  return db
    .select()
    .from(task)
    .where(
      and(
        inArray(task.status, ['pending', 'running']),
        isNull(task.deletedAt),
        isNotNull(task.holdExpiresAt),
        lt(task.holdExpiresAt, now),
        or(isNull(task.fetchMode), ne(task.fetchMode, 'direct')),
      ),
    )
    .orderBy(asc(task.holdExpiresAt))
    .limit(limit);
}

// --- webhook deliveries (§7.6) ------------------------------------------------------

/**
 * The §7.6 TENANT-LEVEL webhook signing secret (webhook secret 为租户级配置 —
 * the URL may ride the request, the secret NEVER does): read from the
 * tenant's `config` bag under `webhook_secret`. Absent/blank → `undefined`
 * (deliveries go unsigned — the receiver's evt_id idempotency still holds).
 */
export async function getTenantWebhookSecret(
  db: DbOrTx,
  tenantId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ config: tenant.config })
    .from(tenant)
    .where(and(eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .limit(1);
  const secret = rows[0]?.config.webhook_secret;
  return typeof secret === 'string' && secret.length > 0 ? secret : undefined;
}

/**
 * §9.4 tenant policy read (批次4 slice5): may this tenant's artifacts ride the
 * PUBLIC track (stable public URL, cleanup-exempt)? Read from the tenant
 * `config` bag under `artifact_public_allowed` (the `webhook_secret`
 * precedent). Absent → ALLOWED (the public track is already operator-gated at
 * the model's artifact defaults; the tenant key is an opt-OUT restriction).
 * Only an EXPLICIT `false` denies — the §7.5 persist hook then degrades the
 * request to `signed` with a warning (never silently honored, §9.4).
 */
export async function getTenantArtifactPublicAllowed(
  db: DbOrTx,
  tenantId: string,
): Promise<boolean> {
  const rows = await db
    .select({ config: tenant.config })
    .from(tenant)
    .where(and(eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .limit(1);
  return rows[0]?.config.artifact_public_allowed !== false;
}

/**
 * 切换预案② per-tenant gray-release read (批次4 slice6): should THIS tenant's
 * LEGACY sync surfaces (chat/embeddings…) route through the NEW supply
 * gateway? Read from the tenant `config` bag under `gateway_v2` (the
 * `webhook_secret` precedent). Returns the tenant's EXPLICIT boolean, or
 * `undefined` when the tenant has no opinion — the caller falls back to the
 * platform default (SettingsResolver key `GATEWAY_V2_DEFAULT`, see
 * apps/api gateway/gray-release.ts). The NEW task-paradigm endpoints are NOT
 * gated by this flag (预案① 新面全量上线).
 */
export async function getTenantGatewayV2Flag(
  db: DbOrTx,
  tenantId: string,
): Promise<boolean | undefined> {
  const rows = await db
    .select({ config: tenant.config })
    .from(tenant)
    .where(and(eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .limit(1);
  const flag = rows[0]?.config.gateway_v2;
  return typeof flag === 'boolean' ? flag : undefined;
}

// --- §9.4 artifact lifecycle (signed track expiry; public exempt) ---------------------

/** The internal_substate value marking a succeeded task whose SIGNED artifacts lapsed. */
export const ARTIFACT_EXPIRED_SUBSTATE = 'artifact_expired';

/**
 * The §9.4 signed-track expiry feed: SUCCEEDED tasks on the `signed` artifact
 * track whose `artifact_expires_at` lapsed and are not yet marked. The
 * `public` track NEVER appears here (§9.4 豁免清理 — its checksum + lifecycle
 * records stay on the settle event/output by construction); rows already
 * marked ({@link ARTIFACT_EXPIRED_SUBSTATE}) are excluded so the sweep makes
 * progress.
 */
export async function listExpiredSignedArtifactTasks(
  db: DbOrTx,
  now: Date,
  limit = 100,
): Promise<TaskRow[]> {
  return db
    .select()
    .from(task)
    .where(
      and(
        eq(task.status, 'succeeded'),
        eq(task.artifactMode, 'signed'),
        isNull(task.deletedAt),
        isNotNull(task.artifactExpiresAt),
        lt(task.artifactExpiresAt, now),
        or(isNull(task.internalSubstate), ne(task.internalSubstate, ARTIFACT_EXPIRED_SUBSTATE)),
      ),
    )
    .orderBy(asc(task.artifactExpiresAt))
    .limit(limit);
}

/**
 * Mark ONE succeeded task's signed artifacts expired (§9.4 到期 expired —
 * artifact-layer marking): stamp {@link ARTIFACT_EXPIRED_SUBSTATE} and append
 * a task_events record. The task's EXTERNAL status stays `succeeded` — §7.1
 * 终态禁迁移 holds (succeeded is terminal; `transitionTask` rejects terminal
 * sources by construction), so artifact expiry is a PRODUCT-lifecycle marker
 * (`expires_at` already rides the external Task view), not a status move.
 * Idempotent: an already-marked / non-signed / still-live row no-ops (false).
 */
export async function markTaskArtifactExpired(db: DbOrTx, taskId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(task)
      .set({ internalSubstate: ARTIFACT_EXPIRED_SUBSTATE, updatedAt: sql`now()` })
      .where(
        and(
          eq(task.id, taskId),
          eq(task.status, 'succeeded'),
          eq(task.artifactMode, 'signed'),
          isNull(task.deletedAt),
          isNotNull(task.artifactExpiresAt),
          or(isNull(task.internalSubstate), ne(task.internalSubstate, ARTIFACT_EXPIRED_SUBSTATE)),
        ),
      )
      .returning({ id: task.id, artifactExpiresAt: task.artifactExpiresAt });
    const row = rows[0];
    if (!row) return false;
    await appendTaskEvent(tx, {
      taskId,
      fromStatus: 'succeeded',
      toStatus: 'succeeded',
      payload: {
        artifactExpired: true,
        artifactMode: 'signed',
        artifactExpiresAt: row.artifactExpiresAt?.toISOString() ?? null,
      },
    });
    return true;
  });
}

/** Inputs to {@link createWebhookDelivery} — one signed envelope bound for one URL. */
export interface CreateWebhookDeliveryInput {
  taskId: string;
  evtId: string;
  eventType: string;
  url: string;
  /** The complete event envelope (evt_id + type + full Task body), stored verbatim. */
  payload: Record<string, unknown>;
  signature?: string | null | undefined;
  /** First attempt time; omitted → due immediately. */
  nextAttemptAt?: Date | undefined;
}

/**
 * Enqueue one webhook delivery. IDEMPOTENT on `(task_id, evt_id)` (§7.6 —
 * receivers dedupe on evt_id; the sender dedupes here too): a duplicate
 * enqueue conflicts on the unique index and returns `undefined` (already
 * queued — not an error).
 */
export async function createWebhookDelivery(
  db: DbOrTx,
  input: CreateWebhookDeliveryInput,
): Promise<WebhookDeliveryRow | undefined> {
  const rows = await db
    .insert(webhookDeliveries)
    .values({
      taskId: input.taskId,
      evtId: input.evtId,
      eventType: input.eventType,
      url: input.url,
      payload: input.payload,
      signature: input.signature ?? null,
      ...(input.nextAttemptAt !== undefined ? { nextAttemptAt: input.nextAttemptAt } : {}),
    })
    .onConflictDoNothing({ target: [webhookDeliveries.taskId, webhookDeliveries.evtId] })
    .returning();
  return rows[0];
}

/** Due, undelivered deliveries (`pending` AND `next_attempt_at <= now`), oldest-due first. */
export async function listDueWebhookDeliveries(
  db: DbOrTx,
  now: Date,
  limit = 50,
): Promise<WebhookDeliveryRow[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(limit);
}

/** Mark a delivery `sent` with its final attempt count. */
export async function markWebhookDeliverySent(
  db: DbOrTx,
  id: string,
  attempts: number,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status: 'sent', attempts, updatedAt: sql`now()` })
    .where(eq(webhookDeliveries.id, id));
}

/** Dead-letter a delivery after the backoff ladder is exhausted (§7.6 退避档位, slice 4). */
export async function markWebhookDeliveryDead(
  db: DbOrTx,
  id: string,
  attempts: number,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status: 'dead', attempts, updatedAt: sql`now()` })
    .where(eq(webhookDeliveries.id, id));
}

/** Reschedule a failed attempt: bump `attempts`, set the next backoff slot, stay `pending`. */
export async function rescheduleWebhookDelivery(
  db: DbOrTx,
  id: string,
  attempts: number,
  nextAttemptAt: Date,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ attempts, nextAttemptAt, updatedAt: sql`now()` })
    .where(eq(webhookDeliveries.id, id));
}

// --- retention (§7.1 / §9.3) ---------------------------------------------------------

/**
 * Retention sweep: hard-DELETE task_events rows older than `cutoff`, in
 * id-batches (the {@link deleteRelayTracesOlderThan} pattern — never one
 * table-wide lock over a large backlog). task_events is an observability
 * stream, NOT the financial system-of-record: its mig 0071 trigger blocks
 * UPDATE (rows immutable) but deliberately permits DELETE so this sweep can
 * run (§7.1 「retention 与 relay_trace 同策略配置，不默认永久」). Driven by
 * TASK_EVENTS_RETENTION_DAYS (dynamic config → env → code default).
 */
export async function deleteTaskEventsOlderThan(
  db: DbOrTx,
  cutoff: Date,
  batchSize = 5000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const victims = await db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(lt(taskEvents.createdAt, cutoff))
      .limit(batchSize);
    if (victims.length === 0) break;
    await db.delete(taskEvents).where(
      inArray(
        taskEvents.id,
        victims.map((v) => v.id),
      ),
    );
    total += victims.length;
    if (victims.length < batchSize) break;
  }
  return total;
}
