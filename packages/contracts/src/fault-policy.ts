import { z } from 'zod';

/** Backoff spacing between same-channel retries. */
export const BACKOFF_TYPES = ['fixed', 'exponential'] as const;

const timeoutMs = z.number().int().nonnegative().max(3_600_000); // ≤ 1h
const retryCodesSchema = z.array(z.number().int().min(100).max(599)).max(50);
const retryMessagesSchema = z.array(z.string().min(1).max(200)).max(50);

/**
 * Create a {@link faultPolicy} (调用容错策略) — a named, reusable resilience
 * profile bound to channels. camelCase body (contract-first); the four timeouts
 * are milliseconds, the trigger arrays gate same-channel retry.
 */
export const createFaultPolicySchema = z.object({
  name: z.string().min(1),
  /** Surface the first error immediately (no same-channel retry). Default false. */
  fastFail: z.boolean().optional(),
  /** SAME-channel retry attempts after the first failure. Default 0. */
  retryCount: z.number().int().min(0).max(10).optional(),
  backoffType: z.enum(BACKOFF_TYPES).optional(),
  /** Base backoff interval (ms); exponential doubles it per retry. Default 0. */
  backoffMs: z.number().int().nonnegative().max(600_000).optional(),
  /** TCP/TLS connect timeout (ms); null/omitted → client default. */
  connectTimeoutMs: timeoutMs.nullable().optional(),
  /** Time-to-first-token timeout (ms); null/omitted → client default. */
  ttftTimeoutMs: timeoutMs.nullable().optional(),
  /** Whole-request timeout (ms); null/omitted → client default. */
  totalTimeoutMs: timeoutMs.nullable().optional(),
  /** Inter-chunk read-idle timeout for streams (ms); null/omitted → client default. */
  idleTimeoutMs: timeoutMs.nullable().optional(),
  /** HTTP status codes that TRIGGER a retry (e.g. [500,429,404]); empty → adapter default. */
  retryCodes: retryCodesSchema.nullable().optional(),
  /** Error-message substrings that trigger a retry; empty → adapter default. */
  retryMessages: retryMessagesSchema.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().optional(),
});
export type CreateFaultPolicyBody = z.infer<typeof createFaultPolicySchema>;

/** Patch a fault policy (all fields optional; nullable timeouts/triggers clear). */
export const updateFaultPolicySchema = z.object({
  name: z.string().min(1).optional(),
  fastFail: z.boolean().optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  backoffType: z.enum(BACKOFF_TYPES).optional(),
  backoffMs: z.number().int().nonnegative().max(600_000).optional(),
  connectTimeoutMs: timeoutMs.nullable().optional(),
  ttftTimeoutMs: timeoutMs.nullable().optional(),
  totalTimeoutMs: timeoutMs.nullable().optional(),
  idleTimeoutMs: timeoutMs.nullable().optional(),
  retryCodes: retryCodesSchema.nullable().optional(),
  retryMessages: retryMessagesSchema.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().nullable().optional(),
});
export type UpdateFaultPolicyBody = z.infer<typeof updateFaultPolicySchema>;

/** JSON view of a fault policy (snake_case; timeouts/triggers nullable). */
export const faultPolicyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  fast_fail: z.boolean(),
  retry_count: z.number(),
  backoff_type: z.string(),
  backoff_ms: z.number(),
  connect_timeout_ms: z.number().nullable(),
  ttft_timeout_ms: z.number().nullable(),
  total_timeout_ms: z.number().nullable(),
  idle_timeout_ms: z.number().nullable(),
  retry_codes: z.array(z.number()).nullable(),
  retry_messages: z.array(z.string()).nullable(),
  status: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FaultPolicyView = z.infer<typeof faultPolicyViewSchema>;
