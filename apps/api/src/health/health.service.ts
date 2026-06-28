import type { Database } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { createRedis, type Redis } from '@actionow/infra';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { BullmqJobQueue } from '../common/bullmq-queue.js';
import { DB, ENV, JOB_QUEUE } from '../common/tokens.js';

/** A single dependency's readiness verdict. */
export type CheckStatus = 'ok' | 'down';

/** The per-dependency readiness report surfaced by `/readyz`. */
export interface ReadinessChecks {
  postgres: CheckStatus;
  redis: CheckStatus;
  queue: CheckStatus;
}

/** A full readiness verdict: the aggregate plus each dependency's status. */
export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessChecks;
}

/** Per-check timeout: a probe must answer fast or be treated as `down`. */
const CHECK_TIMEOUT_MS = 1_000;

/**
 * Race `op` against a {@link CHECK_TIMEOUT_MS} deadline, mapping success to `ok`
 * and ANY rejection OR timeout to `down`. A readiness check must never hang the
 * probe, so it always resolves (fail-closed) — a slow/unreachable dependency is
 * reported `down`, not awaited forever.
 */
async function probe(op: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('health check timed out'));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([op(), timeout]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Readiness prober for the API's critical dependencies (Postgres, Redis, the
 * BullMQ broker). Each check is bounded by a short timeout and FAILS CLOSED to
 * `down` on any error/timeout, so `/readyz` always answers promptly. Liveness
 * (`/health`) does NOT use this — it returns 200 unconditionally.
 *
 * The Redis check uses a dedicated client built from `REDIS_URL` (so it does
 * not contend with the rate-limiter/breaker clients), opened lazily and closed
 * on shutdown.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private redis: Redis | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(JOB_QUEUE) private readonly queue: BullmqJobQueue,
  ) {}

  /** Close the lazily-opened readiness Redis client on app shutdown. */
  async onModuleDestroy(): Promise<void> {
    if (this.redis !== undefined) {
      await this.redis.quit();
      this.redis = undefined;
    }
  }

  /** Run all dependency checks concurrently and aggregate the verdict. */
  async readiness(): Promise<ReadinessReport> {
    const [postgres, redis, queue] = await Promise.all([
      probe(() => this.db.execute(sql`SELECT 1`)),
      probe(() => this.redisClient().ping()),
      probe(() => this.queue.ping()),
    ]);
    const checks: ReadinessChecks = { postgres, redis, queue };
    const ok = postgres === 'ok' && redis === 'ok' && queue === 'ok';
    return { ok, checks };
  }

  /** The dedicated readiness Redis client, created on first use. */
  private redisClient(): Redis {
    this.redis ??= createRedis(this.env.REDIS_URL);
    return this.redis;
  }
}
