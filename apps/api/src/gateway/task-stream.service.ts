// apps/api/src/gateway/task-stream.service.ts
//
// model-supply-greenfield 批次4 slice3 — `GET /v1/tasks/:id/stream`: task
// progress over SSE until terminal (§5, 承接现 /v1/jobs SSE). The job-stream
// DB-POLL BACKSTOP 范式, re-based onto the task center's OWN event stream:
// each poll (a) catches up task_events past the last delivered seq (§7.1 —
// one `progress` frame per event) and (b) re-reads the authoritative row; a
// terminal status always closes the stream (终态兜底轮询). There is no task
// pub/sub bus yet — slice4's worker/webhook fanout may layer a low-latency
// bus on top; the poll IS the correctness guarantee either way.
import { TERMINAL_TASK_STATUSES } from '@actionow/contracts';
import type { TaskRow } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import { ENV } from '../common/tokens.js';
import { toTaskEventView, toTaskView } from './task-view.js';
import { GatewayTasksService, type TaskScope } from './tasks.service.js';

const TERMINAL: readonly string[] = TERMINAL_TASK_STATUSES;

/** Default DB-poll backstop cadence (ms) — guarantees terminal delivery. */
const DEFAULT_POLL_MS = 2500;
/** Default heartbeat-comment cadence (ms) — keeps idle proxies from closing. */
const DEFAULT_HEARTBEAT_MS = 15000;
/** Default hard cap on a single stream's lifetime (ms). */
const DEFAULT_MAX_MS = 600000;

@Injectable()
export class GatewayTaskStreamService {
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maxMs: number;

  constructor(
    private readonly tasks: GatewayTasksService,
    @Inject(ENV) env: AppEnv,
  ) {
    // Reuse the job-stream knobs — one set of SSE tuning env vars for both faces.
    this.pollMs = env.JOB_STREAM_POLL_MS ?? DEFAULT_POLL_MS;
    this.heartbeatMs = env.JOB_STREAM_HEARTBEAT_MS ?? DEFAULT_HEARTBEAT_MS;
    this.maxMs = env.JOB_STREAM_MAX_MS ?? DEFAULT_MAX_MS;
  }

  /**
   * Drive the SSE stream for an ALREADY-AUTHORIZED task snapshot (the
   * controller ran the tenant/subject-scoped read and 404'd BEFORE any header
   * byte). Frames: `snapshot` (the Task view), `progress` (one per new
   * task_events row, seq order), terminal `done` (succeeded) / `error`
   * (failed/canceled/expired) carrying the final Task view.
   */
  async streamTo(res: Response, snapshot: TaskRow, scope: TaskScope): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    writeFrame(res, 'snapshot', toTaskView(snapshot));
    if (TERMINAL.includes(snapshot.status)) {
      writeFrame(res, terminalEvent(snapshot.status), toTaskView(snapshot));
      res.end();
      return;
    }

    // The snapshot already tells the caller the CURRENT state — only events
    // appended AFTER connect flow as progress frames (no history replay).
    let lastSeq = await this.latestSeq(snapshot.id);
    let closed = false;
    const h: {
      pollTimer?: ReturnType<typeof setInterval>;
      heartbeatTimer?: ReturnType<typeof setInterval>;
      maxTimer?: ReturnType<typeof setTimeout>;
    } = {};

    const teardown = (): void => {
      if (closed) return;
      closed = true;
      if (h.pollTimer !== undefined) clearInterval(h.pollTimer);
      if (h.heartbeatTimer !== undefined) clearInterval(h.heartbeatTimer);
      if (h.maxTimer !== undefined) clearTimeout(h.maxTimer);
    };

    const finish = (view: TaskRow): void => {
      if (closed) return;
      if (!res.writableEnded) {
        writeFrame(res, terminalEvent(view.status), toTaskView(view));
        res.end();
      }
      teardown();
    };

    /**
     * One backstop tick: deliver new events (seq order), then re-read the
     * authoritative row — terminal closes; a vanished row (soft-deleted
     * underneath us) closes as an error frame.
     */
    const reconcile = async (): Promise<void> => {
      if (closed) return;
      const events = await this.tasks.events(snapshot.id, lastSeq);
      for (const event of events) {
        if (res.writableEnded) return;
        writeFrame(res, 'progress', toTaskEventView(event));
        lastSeq = Math.max(lastSeq, event.seq);
      }
      const row = await this.tasks.get(snapshot.id, scope);
      if (row === undefined) {
        finish({ ...snapshot, status: 'failed' });
        return;
      }
      if (TERMINAL.includes(row.status)) finish(row);
    };

    res.on('close', teardown);

    h.pollTimer = setInterval(() => {
      void reconcile().catch(() => {
        // best-effort: a transient read error is retried on the next tick.
      });
    }, this.pollMs);

    h.heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':\n\n');
    }, this.heartbeatMs);

    // ApiKeyGuard only runs at connect — bound an auth-revoked/stuck stream.
    h.maxTimer = setTimeout(() => {
      if (closed) return;
      if (!res.writableEnded) {
        writeFrame(res, 'error', {
          code: 'upstream_timeout',
          message: 'task stream exceeded its maximum duration',
          retryable: true,
          failover: false,
        });
        res.end();
      }
      teardown();
    }, this.maxMs);

    // Fire one immediate reconcile so a status change between the snapshot
    // read and the first poll tick is not delayed a full cadence.
    void reconcile().catch(() => {
      /* covered by the next tick */
    });
  }

  private async latestSeq(taskId: string): Promise<number> {
    const events = await this.tasks.events(taskId, 0);
    return events.at(-1)?.seq ?? 0;
  }
}

/** succeeded → `done`; failed/canceled/expired → `error` (the job-stream精度). */
function terminalEvent(status: string): 'done' | 'error' {
  return status === 'succeeded' ? 'done' : 'error';
}

/** Write one SSE frame: an `event:` line + a single `data:` JSON line. */
function writeFrame(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
