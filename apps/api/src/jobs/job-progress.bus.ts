import { jobProgressChannel, type JobProgressEvent } from '@actionow/engine';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** A handler invoked with each parsed progress event for a subscribed job. */
export type JobProgressHandler = (event: JobProgressEvent) => void;

/**
 * The subscribe surface the SSE service depends on (so a unit test injects a
 * trivial fake). `subscribe` returns an unsubscribe function the caller MUST
 * invoke on disconnect.
 */
export interface JobProgressBus {
  subscribe: (jobId: string, onEvent: JobProgressHandler) => () => void;
}

/**
 * A Redis-pub/sub progress bus over ONE shared, dedicated ioredis SUBSCRIBER
 * client. ioredis enters subscriber mode on the first `subscribe` and then
 * rejects ordinary commands, so this client must be dedicated (never the breaker
 * / rate-limiter / queue client) — the DbModule provides it its own
 * `createRedis(...)`.
 *
 * Channels are ref-counted: a `(jobId)` channel is `SUBSCRIBE`d only when its
 * first handler attaches and `UNSUBSCRIBE`d when its last handler leaves, so N
 * concurrent SSE connections to the same job share ONE Redis subscription and a
 * single shared client serves every job — no per-connection client (which would
 * exhaust file descriptors).
 *
 * Fail-open: this layer is a best-effort optimization. The SSE service's
 * mandatory DB-poll backstop guarantees terminal delivery even if a message is
 * dropped or the client errors.
 */
export class RedisJobProgressBus implements JobProgressBus, OnModuleDestroy {
  /** channel → set of handlers currently attached to it. */
  private readonly handlers = new Map<string, Set<JobProgressHandler>>();
  private wired = false;

  constructor(private readonly client: Redis) {}

  /**
   * Attach `onEvent` to a job's progress channel; SUBSCRIBE on the first handler
   * for that channel. Returns an idempotent unsubscribe that detaches the
   * handler and UNSUBSCRIBEs when it was the last one. Best-effort: a Redis error
   * on (un)subscribe is swallowed (the service's DB-poll backstop covers it).
   */
  subscribe(jobId: string, onEvent: JobProgressHandler): () => void {
    this.wire();
    const channel = jobProgressChannel(jobId);
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set<JobProgressHandler>();
      this.handlers.set(channel, set);
      // First handler for this channel: subscribe. Fire-and-forget; a failure
      // leaves the bus silent for this job, and the DB-poll backstop covers it.
      this.client.subscribe(channel).catch(() => {
        // best-effort: fail-open to the DB-poll backstop.
      });
    }
    set.add(onEvent);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(channel);
      if (current === undefined) return;
      current.delete(onEvent);
      if (current.size === 0) {
        this.handlers.delete(channel);
        this.client.unsubscribe(channel).catch(() => {
          // best-effort: an UNSUBSCRIBE failure only leaves an idle subscription.
        });
      }
    };
  }

  /** Quit the dedicated subscriber client on app shutdown (we own its lifecycle). */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // best-effort: a quit failure on shutdown is non-fatal.
    }
  }

  /** Attach the single `message` listener once, lazily, on first subscribe. */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.client.on('message', (channel: string, payload: string) => {
      const set = this.handlers.get(channel);
      if (set === undefined || set.size === 0) return;
      let event: JobProgressEvent;
      try {
        event = JSON.parse(payload) as JobProgressEvent;
      } catch {
        return; // ignore a malformed frame
      }
      // Snapshot the handler set so a handler that unsubscribes mid-dispatch does
      // not perturb the iteration.
      for (const handler of [...set]) {
        try {
          handler(event);
        } catch {
          // A handler throw must not break dispatch to siblings.
        }
      }
    });
  }
}
