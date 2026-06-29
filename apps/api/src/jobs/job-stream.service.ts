import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import type { TenantContext } from '../auth/auth.service.js';
import { ENV, JOB_PROGRESS } from '../common/tokens.js';
import type { JobProgressBus } from './job-progress.bus.js';
import type { JobView } from './jobs.service.js';
import { JobsService } from './jobs.service.js';

/** Job statuses that are terminal (the stream closes once one is reached). */
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** Default DB-poll backstop cadence (ms) — guarantees terminal delivery. */
const DEFAULT_POLL_MS = 2500;
/** Default heartbeat-comment cadence (ms) — keeps idle proxies from closing. */
const DEFAULT_HEARTBEAT_MS = 15000;
/** Default hard cap on a single stream's lifetime (ms) — bounds stuck/auth-revoked conns. */
const DEFAULT_MAX_MS = 600000;

/**
 * Streams a job's status/progress to a client over Server-Sent Events until the
 * job is terminal, then closes. Mirrors the project's manual-express SSE pattern
 * (see `chat/sse.ts` + `execution/run.controller.ts`) rather than Nest `@Sse()`.
 *
 * Correctness does NOT depend on pub/sub delivery: a connect-time DB snapshot
 * covers the terminal-before-subscribe race, and a periodic DB-poll backstop
 * guarantees the terminal event arrives even if the (at-most-once) pub/sub frame
 * is dropped. The Redis bus is a latency optimization layered on top.
 */
@Injectable()
export class JobStreamService {
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maxMs: number;

  constructor(
    private readonly jobs: JobsService,
    @Inject(JOB_PROGRESS) private readonly bus: JobProgressBus,
    @Inject(ENV) env: AppEnv,
  ) {
    this.pollMs = env.JOB_STREAM_POLL_MS ?? DEFAULT_POLL_MS;
    this.heartbeatMs = env.JOB_STREAM_HEARTBEAT_MS ?? DEFAULT_HEARTBEAT_MS;
    this.maxMs = env.JOB_STREAM_MAX_MS ?? DEFAULT_MAX_MS;
  }

  /**
   * Drive the SSE stream for `jobId`. The ownership/auth check (`jobs.get`) runs
   * FIRST, BEFORE any byte is written, so an unowned/missing job throws
   * `resource_not_found` (HTTP 404) via the global filter — exact parity with
   * `GET /v1/jobs/:id`. Only after that check do we flush the SSE headers.
   */
  async streamTo(res: Response, jobId: string, ctx: TenantContext): Promise<void> {
    // (a) Connect-time auth + existence. THROWS (404) before any header flush.
    const snapshot = await this.jobs.get(jobId, ctx);

    // (b) Commit the event-stream response (reuse the project's header set).
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // (c) Emit the current view. If already terminal, emit the terminal frame
    // and close immediately — late-subscriber correctness, no subscription.
    writeFrame(res, 'snapshot', snapshot);
    if (TERMINAL.has(snapshot.status)) {
      writeFrame(res, terminalEvent(snapshot.status), snapshot);
      res.end();
      return;
    }

    let lastStatus = snapshot.status;
    let closed = false;
    // A mutable holder for the subscription + timers so `teardown` (defined now,
    // but only ever invoked asynchronously) can clean up handles wired below.
    const h: {
      unsubscribe?: () => void;
      pollTimer?: ReturnType<typeof setInterval>;
      heartbeatTimer?: ReturnType<typeof setInterval>;
      maxTimer?: ReturnType<typeof setTimeout>;
    } = {};

    const teardown = (): void => {
      if (closed) return;
      closed = true;
      h.unsubscribe?.();
      if (h.pollTimer !== undefined) clearInterval(h.pollTimer);
      if (h.heartbeatTimer !== undefined) clearInterval(h.heartbeatTimer);
      if (h.maxTimer !== undefined) clearTimeout(h.maxTimer);
    };

    /** Emit the terminal frame + close the response, then tear down. */
    const finish = (view: JobView): void => {
      if (closed) return;
      if (!res.writableEnded) {
        writeFrame(res, terminalEvent(view.status), view);
        res.end();
      }
      teardown();
    };

    /**
     * Re-read the authoritative, ownership-scoped view. On a status change emit
     * the appropriate frame; on terminal, finish. Never trusts the wire blindly —
     * even a published terminal triggers a DB re-read before we close. A vanished
     * job (deleted underneath us) ends the stream cleanly.
     */
    const reconcile = async (): Promise<void> => {
      if (closed) return;
      const view = await this.jobs.getOrNull(jobId, ctx);
      if (view === undefined) {
        finish({ ...snapshot, status: 'failed' });
        return;
      }
      if (view.status === lastStatus) return;
      lastStatus = view.status;
      if (TERMINAL.has(view.status)) {
        finish(view);
        return;
      }
      writeFrame(res, 'progress', view);
    };

    // (h) Client disconnect → unsubscribe + clear both timers.
    res.on('close', teardown);

    // (d) Subscribe to the pub/sub bus. Each event triggers a DB-confirmed
    // reconcile (we don't emit straight from the wire).
    h.unsubscribe = this.bus.subscribe(jobId, () => {
      void reconcile().catch(() => {
        // best-effort: a reconcile error is covered by the DB-poll backstop.
      });
    });

    // (e) DB-poll backstop — the GUARANTEE that the terminal event always
    // arrives even if every pub/sub frame is dropped.
    h.pollTimer = setInterval(() => {
      void reconcile().catch(() => {
        // best-effort: a transient read error is retried on the next tick.
      });
    }, this.pollMs);

    // (f) Heartbeat comment to keep idle proxies/load balancers from closing.
    h.heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':\n\n');
    }, this.heartbeatMs);

    // (h, cont.) Hard cap: ApiKeyGuard only runs at connect, so bound an
    // auth-revoked / stuck connection. Emit a timeout error frame then close.
    h.maxTimer = setTimeout(() => {
      if (closed) return;
      if (!res.writableEnded) {
        writeFrame(res, 'error', {
          code: 'upstream_timeout',
          message: 'job stream exceeded its maximum duration',
          retryable: true,
        });
        res.end();
      }
      teardown();
    }, this.maxMs);
  }
}

/** Map a terminal status to its SSE event name (`done` on success, else `error`). */
function terminalEvent(status: string): 'done' | 'error' {
  return status === 'succeeded' ? 'done' : 'error';
}

/** Write one SSE frame: an `event:` line + a single `data:` JSON line. */
function writeFrame(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
