// packages/engine/src/gateway/task-webhook.ts
//
// model-supply-greenfield 批次4 slice4 — the §7.6 DOWNSTREAM webhook event
// envelope + delivery ladder for the NEW-WORLD task center. The old-world
// `webhook_outbox` / WebhookDispatcher stay untouched (双面并存); this module
// re-uses the same DISCIPLINE (drain-due / backoff / dead-letter / SSRF guard)
// over the slice1 `webhook_deliveries` table with the design's envelope:
//
//   - Event envelope { evt_id, event_type, created_at, task: <full external
//     Task body> } — evt_id is DETERMINISTIC per logical event, so BOTH sides
//     dedupe: the sender via the UNIQUE (task_id, evt_id) enqueue, receivers
//     by evt_id (§7.6 接收方按 evt_id 幂等).
//   - HMAC WITH TIMESTAMP (§3.4.5 口径, fixing the legacy timestamp-less
//     header): `t=<unix seconds>,v1=hex(HMAC-SHA256(secret, t + "." + body))`.
//     The secret is TENANT-LEVEL configuration (tenant.config.webhook_secret —
//     请求级 URL 可覆盖, secret 不随请求传); the URL rides the task row
//     (`callback_url`). Signing happens AT DISPATCH over the exact body being
//     sent — jsonb round-trips do not preserve key order, so an enqueue-time
//     byte signature could never re-verify (the stored `signature` column
//     keeps the enqueue-time reference for audit only).
//   - Backoff = the FIXED five-slot ladder (砍刀: 不做可配) 5s / 30s / 2m /
//     10m / 1h; the attempt after the last slot dead-letters (+ alert log).
//
// Webhook delivery NEVER touches the money path — emission is best-effort
// from the settle/fail funnels and a permanently failing hook only
// dead-letters (the ledger is already correct).
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { HttpClient } from '@actionow/contracts';
import type { DbOrTx, TaskRow, WebhookDeliveryRow } from '@actionow/db';
import {
  createWebhookDelivery,
  listDueWebhookDeliveries,
  markWebhookDeliveryDead,
  markWebhookDeliverySent,
  rescheduleWebhookDelivery,
} from '@actionow/db';
import { assertEgressAllowed } from '@actionow/infra';

import { toTaskView } from './task-view.js';

// --- vocabulary -----------------------------------------------------------------

/** The §7.6 event-type vocabulary carried on the envelope (`event_type`). */
export const TASK_WEBHOOK_EVENT_TYPES = [
  'task.running',
  'task.progress',
  'task.succeeded',
  'task.failed',
  'task.canceled',
] as const;
export type TaskWebhookEventType = (typeof TASK_WEBHOOK_EVENT_TYPES)[number];

/** The header carrying the timestamped HMAC signature (`t=<ts>,v1=<hex>`). */
export const TASK_WEBHOOK_SIGNATURE_HEADER = 'X-Actionow-Signature';
/** The header naming the envelope's event type (routing convenience only). */
export const TASK_WEBHOOK_EVENT_HEADER = 'X-Actionow-Event';

/**
 * The FIXED five-slot backoff ladder (§7.6 退避 5 档, 砍刀固定): the n-th
 * FAILED attempt reschedules after `LADDER[n-1]`; the attempt after the last
 * slot (i.e. attempt 6) dead-letters. Internal-tenant default per design —
 * external 24h extension is a future product knob, deliberately not built.
 */
export const TASK_WEBHOOK_BACKOFF_LADDER_MS: readonly number[] = [
  5_000, 30_000, 120_000, 600_000, 3_600_000,
];

// --- envelope (§7.6 事件信封) ------------------------------------------------------

/** The §7.6 event envelope, verbatim what lands on the wire (snake_case). */
export interface TaskWebhookEnvelope extends Record<string, unknown> {
  evt_id: string;
  event_type: TaskWebhookEventType;
  /** ISO-8601 creation instant of the EVENT (not the delivery attempt). */
  created_at: string;
  /** The COMPLETE external Task body (§5 shape) at event time. */
  task: ReturnType<typeof toTaskView>;
}

/**
 * Deterministic evt_id per LOGICAL event: terminal states and `running` occur
 * once per task; `progress` is keyed by the reported value so a re-observed
 * identical progress dedupes while a new value is a new event. Determinism is
 * the §7.6 idempotency backbone — a double emission (callback fast path vs
 * poll backstop racing, sweep re-runs) collides on UNIQUE (task_id, evt_id)
 * and no-ops instead of double-delivering.
 */
export function taskWebhookEvtId(
  taskId: string,
  eventType: TaskWebhookEventType,
  progress?: number,
): string {
  const suffix = eventType.replace('task.', '');
  return eventType === 'task.progress'
    ? `evt_${taskId}_${suffix}_${String(progress ?? 0)}`
    : `evt_${taskId}_${suffix}`;
}

/** Build the §7.6 envelope for one task event (pure). */
export function buildTaskWebhookEnvelope(
  task: TaskRow,
  eventType: TaskWebhookEventType,
  now: Date,
): TaskWebhookEnvelope {
  return {
    evt_id: taskWebhookEvtId(task.id, eventType, task.progress ?? undefined),
    event_type: eventType,
    created_at: now.toISOString(),
    task: toTaskView(task),
  };
}

// --- HMAC with timestamp (§7.6 / §3.4.5 口径) ---------------------------------------

/** Sign a webhook body: `t=<unix seconds>,v1=hex(HMAC-SHA256(secret, t + "." + body))`. */
export function signTaskWebhook(secret: string, body: string, tsSeconds: number): string {
  const t = Math.floor(tsSeconds);
  const mac = createHmac('sha256', secret)
    .update(`${String(t)}.${body}`)
    .digest('hex');
  return `t=${String(t)},v1=${mac}`;
}

/**
 * Verify a `t=...,v1=...` signature over the raw body (constant-time compare
 * + replay window). The reference implementation the SDK's `verifyWebhook`
 * (slice6) mirrors; `toleranceSeconds` must cover the retry ladder horizon
 * (each attempt is re-signed fresh, so the default 5 minutes suffices).
 */
export function verifyTaskWebhookSignature(
  secret: string,
  body: string,
  header: string,
  opts: { nowSeconds: number; toleranceSeconds?: number },
): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header.trim());
  if (match === null) return false;
  const ts = Number(match[1]);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (!Number.isFinite(ts) || Math.abs(opts.nowSeconds - ts) > tolerance) return false;
  const expected = createHmac('sha256', secret)
    .update(`${String(ts)}.${body}`)
    .digest('hex');
  const a = Buffer.from(match[2] ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- emission (the producer side) ------------------------------------------------------

/**
 * The injectable emitter seam: the settle/fail funnels (settle-task.ts), the
 * dispatch running-transition (execute.ts) and the recovery/callback paths
 * (task-recovery.ts) all emit through this signature. Production default =
 * {@link emitTaskWebhookEvent}; tests inject recorders.
 */
export type TaskWebhookEmitter = (
  db: DbOrTx,
  task: TaskRow,
  eventType: TaskWebhookEventType,
  now?: Date,
) => Promise<WebhookDeliveryRow | undefined>;

/**
 * Enqueue one §7.6 delivery for a task event. No `callback_url` on the row →
 * no-op (webhooks are strictly opt-in per request). A duplicate logical event
 * collides on UNIQUE (task_id, evt_id) and returns `undefined` (already
 * queued). The stored `signature` is intentionally null — the dispatcher
 * signs AT SEND over the exact bytes it posts (see module header).
 */
export async function emitTaskWebhookEvent(
  db: DbOrTx,
  task: TaskRow,
  eventType: TaskWebhookEventType,
  now: Date = new Date(),
): Promise<WebhookDeliveryRow | undefined> {
  if (task.callbackUrl === null) return undefined;
  const envelope = buildTaskWebhookEnvelope(task, eventType, now);
  return createWebhookDelivery(db, {
    taskId: task.id,
    evtId: envelope.evt_id,
    eventType,
    url: task.callbackUrl,
    payload: envelope,
    signature: null,
  });
}

/**
 * Best-effort emission wrapper: webhook enqueue must NEVER fail (or delay
 * classification of) the money path it rides on — a failed enqueue is logged
 * and swallowed; the task row itself remains the source of truth.
 */
export async function emitTaskWebhookBestEffort(
  wiring: { db: DbOrTx; emit?: TaskWebhookEmitter | undefined },
  task: TaskRow | undefined,
  eventType: TaskWebhookEventType,
  now?: Date,
): Promise<void> {
  if (task?.callbackUrl == null) return;
  const emit = wiring.emit ?? emitTaskWebhookEvent;
  try {
    await emit(wiring.db, task, eventType, now);
  } catch (err) {
    // Swallowed by design (§7.6 不入钱路) — the delivery ladder is an
    // optimization; GET /v1/tasks/:id remains the terminal guarantee.
    console.error(
      `task-webhook enqueue failed for ${task.id} (${eventType}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- the dispatcher (worker sweep side) ---------------------------------------------------

export interface TaskWebhookDispatcherOptions {
  /** Rows processed per `dispatchDue` call (default 50). */
  batchSize?: number;
  /**
   * Resolve the TENANT-LEVEL signing secret for one delivery row (§7.6). The
   * worker binds task → tenant → `getTenantWebhookSecret`; absent/undefined →
   * the delivery goes unsigned.
   */
  resolveSecret?: (row: WebhookDeliveryRow) => Promise<string | undefined>;
  /** SSRF egress guard (default: infra strict policy). Rejects by throwing. */
  assertEgressAllowed?: (url: string) => Promise<void>;
  /** Unix-seconds clock for the per-attempt signature timestamp (tests). */
  nowSeconds?: () => number;
  /** Ladder override for TESTS ONLY — production keeps the fixed five slots. */
  backoffLadderMs?: readonly number[];
}

export interface TaskWebhookDispatchSummary {
  processed: number;
  sent: number;
  retried: number;
  dead: number;
}

/**
 * Drains due `webhook_deliveries` (§7.6): for each row, POSTs the stored
 * envelope with a FRESH `t=<ts>,v1=<hmac>` signature (tenant secret) and the
 * event-type header. 2xx → `sent`; failure → reschedule on the fixed ladder,
 * dead-letter (+ alert log) once the ladder is exhausted; an SSRF-blocked URL
 * dead-letters immediately (it can never legitimately succeed).
 */
export class TaskWebhookDispatcher {
  private readonly batchSize: number;
  private readonly ladder: readonly number[];
  private readonly resolveSecret:
    | ((row: WebhookDeliveryRow) => Promise<string | undefined>)
    | undefined;
  private readonly egressGuard: (url: string) => Promise<void>;
  private readonly nowSeconds: () => number;

  constructor(options: TaskWebhookDispatcherOptions = {}) {
    this.batchSize = options.batchSize ?? 50;
    this.ladder = options.backoffLadderMs ?? TASK_WEBHOOK_BACKOFF_LADDER_MS;
    this.resolveSecret = options.resolveSecret;
    this.egressGuard =
      options.assertEgressAllowed ?? ((url: string): Promise<void> => assertEgressAllowed(url));
    this.nowSeconds = options.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  }

  async dispatchDue(db: DbOrTx, http: HttpClient, now: Date): Promise<TaskWebhookDispatchSummary> {
    const due = await listDueWebhookDeliveries(db, now, this.batchSize);
    const summary: TaskWebhookDispatchSummary = { processed: 0, sent: 0, retried: 0, dead: 0 };

    for (const row of due) {
      summary.processed += 1;
      const attempts = row.attempts + 1;

      if (await this.egressBlocked(row.url)) {
        await markWebhookDeliveryDead(db, row.id, attempts);
        this.alertDead(row, attempts, 'egress blocked (SSRF guard)');
        summary.dead += 1;
        continue;
      }

      const ok = await this.deliver(db, http, row);
      if (ok) {
        await markWebhookDeliverySent(db, row.id, attempts);
        summary.sent += 1;
        continue;
      }

      // Fixed ladder: failure n (1-based) waits LADDER[n-1]; past the last
      // slot the row dead-letters (§7.6 dead 后告警).
      if (attempts > this.ladder.length) {
        await markWebhookDeliveryDead(db, row.id, attempts);
        this.alertDead(row, attempts, 'backoff ladder exhausted');
        summary.dead += 1;
        continue;
      }
      const delay = this.ladder[attempts - 1] ?? this.ladder[this.ladder.length - 1] ?? 3_600_000;
      await rescheduleWebhookDelivery(db, row.id, attempts, new Date(now.getTime() + delay));
      summary.retried += 1;
    }

    return summary;
  }

  private async egressBlocked(url: string): Promise<boolean> {
    try {
      await this.egressGuard(url);
      return false;
    } catch {
      return true;
    }
  }

  /** POST the envelope with a FRESH per-attempt signature; `true` on a 2xx. */
  private async deliver(db: DbOrTx, http: HttpClient, row: WebhookDeliveryRow): Promise<boolean> {
    const body = JSON.stringify(row.payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [TASK_WEBHOOK_EVENT_HEADER]: row.eventType,
    };
    if (this.resolveSecret !== undefined) {
      const secret = await this.resolveSecret(row);
      if (secret !== undefined) {
        headers[TASK_WEBHOOK_SIGNATURE_HEADER] = signTaskWebhook(secret, body, this.nowSeconds());
      }
    }
    try {
      // The HttpClient JSON-serializes `body` — the same JSON.stringify the
      // signature above was computed over, so bytes and MAC agree.
      const res = await http.request({ method: 'POST', url: row.url, headers, body: row.payload });
      return res.ok;
    } catch {
      return false; // network failure — the ladder handles the retry
    }
  }

  private alertDead(row: WebhookDeliveryRow, attempts: number, reason: string): void {
    // §7.6 dead 后告警 — structured log line (metrics/alerting wiring is ops').
    console.error(
      `task-webhook DEAD delivery ${row.id} (task ${row.taskId}, evt ${row.evtId}, ${String(attempts)} attempts): ${reason}`,
    );
  }
}
