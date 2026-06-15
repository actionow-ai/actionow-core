import { Redis } from 'ioredis';

/**
 * Create an ioredis client for the rate limiter (and any other infra Redis use).
 *
 * `maxRetriesPerRequest: null` matches the BullMQ connection style used
 * elsewhere so a transient Redis blip surfaces as a retried command rather than
 * a hard rejection. The caller owns the client's lifecycle (`quit()` on
 * shutdown).
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export type { Redis } from 'ioredis';
