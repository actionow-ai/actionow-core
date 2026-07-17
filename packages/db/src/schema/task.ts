import type { GatewayError, GatewayUsage, PriceCardSnapshotRef } from '@actionow/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { account, subAccount } from './accounts.js';
import { apiKey, subject, tenant } from './identity.js';
import { supplyModel, supplyOffering } from './supply.js';

// model-supply-greenfield 批次4 slice1 — the NEW-WORLD task center data layer
// (design §7): `task` + `task_events` (append-only event stream, §7.1) +
// `webhook_deliveries` (downstream webhook delivery records, §7.6). The
// old-world `job` / `webhook_outbox` tables are NOT touched — the two worlds
// coexist while batch 4 lands.
//
// Vocabulary comes verbatim from the FROZEN batch-0 contracts
// (@actionow/contracts gateway-ir.ts): TASK_STATUSES (the external six-state
// machine pending/running/succeeded/failed/canceled/expired),
// TERMINAL_TASK_STATUSES, ARTIFACT_MODES, FETCH_MODES and
// PriceCardSnapshotRef. Enum columns are text + CHECK (no pgEnum in this
// repo); `operation` deliberately carries NO CHECK — OPERATIONS is
// additive-only frozen, and a DB CHECK would demand a migration for every new
// operation while the zod contract already gates writes (留活).

/**
 * Task (§7.1) — the task center's canonical entity, one row per async task.
 * External six-state machine on `status` (CHECK, verbatim TASK_STATUSES);
 * internal sub-states (`upstream_submitted` / `generating` / `transferring` …)
 * ride the separate `internal_substate` column and NEVER leak into the IR.
 *
 * The row is MUTABLE (guarded transitions via `transitionTask`, lease renewal,
 * progress) — the immutable history lives in {@link taskEvents}. Soft-deleted
 * via `deleted_at` (a task is an entity, not a ledger); billing/audit rows
 * referencing it survive (§2.7 末段).
 *
 * Idempotency (§5, §2.6): scope = (tenant, key). The partial unique index on
 * `(tenant_id, api_key_id, idempotency_key)` is the race-safe claim backstop;
 * `request_fingerprint` disambiguates same-key-same-body (replay) from
 * same-key-different-body (409 conflict).
 *
 * Lease recovery (§7.2): `owner_node` + `lease_until` are used ONLY for
 * recoverable fetch modes (`submit_poll` / `submit_callback`); `direct` is
 * at-most-once and is never leased (§3).
 *
 * Hold TTL (§7.3): `hold_expires_at` = created_at + model.max_run_time +
 * buffer — decoupled from the legacy 15-minute default. `account_id` /
 * `sub_account_id` record WHERE the hold landed so expiry/failure can roll it
 * back against the right wallet.
 */
export const task = pgTable(
  'task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    /** The calling api_key (§2.6 attribution + the (tenant, key) idempotency scope). Null → console/admin-created. */
    apiKeyId: uuid('api_key_id').references(() => apiKey.id),
    /** End-user (subject) attribution (§2.6); null → tenant-level. Survives subject deletion. */
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    /** Operation surface (OPERATIONS vocabulary; zod-gated, no CHECK — see header). */
    operation: text('operation').notNull(),
    /** The addressed NEW-WORLD model (product face). */
    modelId: uuid('model_id').references(() => supplyModel.id),
    /** The offering the planner SELECTED (§8); null until routed. Echoed on responses (servedBy). */
    offeringId: uuid('offering_id').references(() => supplyOffering.id),
    // status: the EXTERNAL six-state machine (frozen TASK_STATUSES §7.1).
    status: text('status').notNull().default('pending'),
    /** Task-center-private sub-state (upstream_submitted / generating / transferring …, §7.1); never IR. */
    internalSubstate: text('internal_substate'),
    /** Progress percentage 0–100 when the upstream reports one (§7.1). */
    progress: integer('progress'),
    /**
     * The planner's fetch-mode decision for the selected offering (§3),
     * back-filled at planning time. Determines recoverability: only
     * `submit_poll` / `submit_callback` tasks participate in lease takeover.
     */
    fetchMode: text('fetch_mode'),
    /** The upstream's task handle, recorded after submit (§7.4 先落库再调上游; poll/callback correlation key). */
    upstreamTaskId: text('upstream_task_id'),
    // --- lease (§7.2, recoverable fetch modes only) --------------------------
    ownerNode: text('owner_node'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    // --- hold TTL (§7.3: max_run + buffer, decoupled from the 15min default) --
    /** Snapshot of the model's max_run_time at creation (offerings may clamp further via min()). */
    maxRunTimeSeconds: integer('max_run_time_seconds'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    /** µ-credits held for this task; released/settled on terminal transition. */
    holdAmount: bigint('hold_amount', { mode: 'bigint' }),
    /** The tenant wallet the hold landed on (rollback target). */
    accountId: uuid('account_id').references(() => account.id),
    /** The subject sub-wallet the hold landed on instead, when HARD mode (rollback target). */
    subAccountId: uuid('sub_account_id').references(() => subAccount.id, {
      onDelete: 'set null',
    }),
    // --- billing snapshot (§9.2) ----------------------------------------------
    /** `true` when usage was PLATFORM-ESTIMATED, not upstream-reported (§9.2 estimated 标志). */
    estimated: boolean('estimated').notNull().default(false),
    /** Sale-side price snapshot {card_id, version} taken for the billing event (§9.2). */
    saleCardRef: jsonb('sale_card_ref').$type<PriceCardSnapshotRef>(),
    /** Cost-side price snapshot {card_id, version} (§9.2 两侧独立可对账). */
    costCardRef: jsonb('cost_card_ref').$type<PriceCardSnapshotRef>(),
    // --- artifacts (§9.4 产物双轨) ---------------------------------------------
    /** Resolved artifact track (frozen ARTIFACT_MODES: signed | public); null → not yet resolved. */
    artifactMode: text('artifact_mode'),
    /** When a `signed` artifact's retention lapses → platform assigns `expired` (§9.4). */
    artifactExpiresAt: timestamp('artifact_expires_at', { withTimezone: true }),
    // --- idempotency (§5) ------------------------------------------------------
    /** Fingerprint (hash) of the canonical request body — same key + different fingerprint ⇒ 409. */
    requestFingerprint: text('request_fingerprint'),
    idempotencyKey: text('idempotency_key'),
    /** Downstream webhook URL for task updates (§7.6; the SECRET is tenant config, never request-borne). */
    callbackUrl: text('callback_url'),
    // --- payloads --------------------------------------------------------------
    /** Canonical inputs snapshot (IR-derived); the contract layer shapes it. */
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull(),
    /** Operation-specific normalized result payload (artifact refs …), present on success. */
    output: jsonb('output'),
    usage: jsonb('usage').$type<GatewayUsage>(),
    error: jsonb('error').$type<GatewayError>(),
    // --- timestamps (§7.1 三时间戳 + bookkeeping) -------------------------------
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Tenant list view (GET /v1/tasks, keyset newest-first).
    index('task_tenant_created_idx').on(t.tenantId, t.createdAt),
    // Live-task sweeps (hold reaper / lease sweep): only non-terminal rows.
    index('task_live_status_idx')
      .on(t.status)
      .where(sql`status IN ('pending', 'running')`),
    // Lease takeover scan (§7.2): only leased rows.
    index('task_lease_idx')
      .on(t.leaseUntil)
      .where(sql`lease_until IS NOT NULL`),
    // Hold-expiry reaper (§7.3), mirroring job_due_idx: only live held tasks.
    index('task_hold_due_idx')
      .on(t.holdExpiresAt)
      .where(sql`hold_expires_at IS NOT NULL AND status IN ('pending', 'running')`),
    // Callback/poll correlation: find the task by the upstream's handle.
    index('task_upstream_idx')
      .on(t.upstreamTaskId)
      .where(sql`upstream_task_id IS NOT NULL`),
    // §5 idempotency claim backstop: scope = (tenant, key) per §2.6. Soft-deleted
    // rows free the slot (mig 0052 partial-unique pattern). NULL api_key_id rows
    // never collide (PG unique-NULL semantics) — idempotency is key-scoped only.
    // INVARIANT (批次4 slice2 复核): GatewayRequest.apiKeyId is contract-required
    // (z.string().min(1)), so every gateway-written claim row carries a NON-NULL
    // api_key_id and the no-dedup NULL leg is unreachable today. If a keyless
    // writer ever appears, replace this with a COALESCE(api_key_id, '')
    // expression index (new migration) — do not rely on this comment alone.
    uniqueIndex('task_idempotency_uq')
      .on(t.tenantId, t.apiKeyId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL AND deleted_at IS NULL`),
    // The six-state machine, verbatim TASK_STATUSES (frozen §7.1).
    check(
      'task_status_allowed',
      sql`${t.status} IN ('pending', 'running', 'succeeded', 'failed', 'canceled', 'expired')`,
    ),
    check('task_progress_range', sql`${t.progress} BETWEEN 0 AND 100`),
    // Frozen FETCH_MODES (§3); NULL (unplanned) passes.
    check(
      'task_fetch_mode_allowed',
      sql`${t.fetchMode} IN ('direct', 'stream', 'submit_poll', 'submit_callback')`,
    ),
    // Frozen ARTIFACT_MODES (§9.4); NULL (unresolved) passes.
    check('task_artifact_mode_allowed', sql`${t.artifactMode} IN ('signed', 'public')`),
  ],
);

/**
 * task_events (§7.1) — the APPEND-ONLY per-task event stream: every status
 * transition (and progress/substate observation) appends one row with a
 * per-task monotonic `seq`. `payload` is clipped to ~4KB at the REPO layer
 * (oversized upstream raw is truncated, §7.1) — the DB stores what it is
 * given verbatim.
 *
 * Immutability: mig 0071 attaches a hand-written BEFORE UPDATE trigger
 * (mig 0052 范式) that rejects ALL updates — this table has no nullable FK, so
 * there is no ON DELETE SET NULL to permit. DELETE is deliberately NOT blocked:
 * unlike ledger_txn/audit_log, task_events carries a retention policy
 * (§7.1/§9.3 — `deleteTaskEventsOlderThan` + TASK_EVENTS_RETENTION_DAYS), so
 * the reaper must be able to prune. No `updated_at` (rows are never mutated).
 */
export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id),
    /** Per-task monotonic sequence (1-based); assigned in `appendTaskEvent`. */
    seq: integer('seq').notNull(),
    /** Null for the birth event (creation → pending). */
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** Observation payload (TaskUpdate extract / EffectiveParams / error …), repo-clipped to ~4KB. */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Monotonic per-task ordering + the seq-race backstop (appendTaskEvent
    // recomputes on conflict); doubles as the task_id lookup index.
    uniqueIndex('task_events_task_seq_uq').on(t.taskId, t.seq),
    // Retention sweep (deleteTaskEventsOlderThan) range-scans created_at.
    index('task_events_created_idx').on(t.createdAt),
  ],
);

/**
 * webhook_deliveries (§7.6) — one row per (task, event) downstream webhook
 * delivery. `evt_id` is the event idempotency key: receivers dedupe on it, and
 * the UNIQUE (task_id, evt_id) makes the SENDING side idempotent too (a replayed
 * enqueue is a no-op). `payload` is the COMPLETE event envelope (evt_id + event
 * type + full Task body); `signature` is the HMAC-with-timestamp header value
 * (tenant-level secret, §7.6). Backoff ladder/dispatcher lands in slice 4 —
 * this table only persists the delivery state machine pending → sent | dead.
 *
 * The old-world `webhook_outbox` stays untouched (job-path deliveries); the
 * design's envelope + evt_id idempotency do not fit its columns, so the task
 * center gets its own table.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id),
    /** Event idempotency key (§7.6) — rides the envelope; receivers dedupe on it. */
    evtId: text('evt_id').notNull(),
    /** task.running / task.progress / task.succeeded / … (envelope vocabulary, slice 4). */
    eventType: text('event_type').notNull(),
    url: text('url').notNull(),
    /** The complete signed event envelope, stored verbatim for replay/audit. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // status: pending (default) → sent | dead.
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** HMAC-with-timestamp signature computed at enqueue; null until slice 4 wires signing. */
    signature: text('signature'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Send-side idempotency: one delivery row per (task, event).
    uniqueIndex('webhook_deliveries_task_evt_uq').on(t.taskId, t.evtId),
    // Dispatcher due-scan: only undelivered rows.
    index('webhook_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    check('webhook_deliveries_status_allowed', sql`${t.status} IN ('pending', 'sent', 'dead')`),
  ],
);
