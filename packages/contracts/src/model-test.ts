import { z } from 'zod';

/**
 * Pre-add model validation (操作员接入新模型前的测试). A CANDIDATE test: the
 * `model` need NOT exist yet — the probe runs against the resource's channel
 * (or a specified `channelId`) so the operator validates connectivity +
 * functionality BEFORE the `model` row is persisted. The frontend only creates
 * the model once this passes (or the operator force-adds it `disabled`).
 */
export const modelTestRequestSchema = z.object({
  /** The chat/media `resource` whose channel carries the upstream + credentials. */
  resourceId: z.string().min(1),
  /** The candidate model name (sent upstream unless the channel pins a `model`). */
  model: z.string().min(1),
  /** Optional: probe a SPECIFIC channel; default = the resource's first active channel. */
  channelId: z.string().optional(),
});
export type ModelTestRequest = z.infer<typeof modelTestRequestSchema>;

/** One leg of the two-part probe. `code` carries the unified error code on failure. */
export const modelTestCheckSchema = z.object({
  ok: z.boolean(),
  /** Human-readable outcome (operator-facing; safe to render verbatim). */
  message: z.string(),
  /** The {@link UnifiedErrorCode} when `ok` is false (e.g. `unauthorized`, `job_failed`). */
  code: z.string().optional(),
});
export type ModelTestCheck = z.infer<typeof modelTestCheckSchema>;

/**
 * The probe result. Two independent legs:
 * - `connectivity` — did we REACH the upstream and AUTHENTICATE? (`unauthorized`
 *   / transport / timeout failures fail this leg).
 * - `functional` — did the model actually PRODUCE valid output? (a non-empty chat
 *   completion / a generated asset). A reached-but-erroring upstream passes
 *   connectivity and fails functional.
 *
 * `functional.ok` is the gate the frontend keys on: both green → add `active`;
 * any red → offer force-add (`disabled`).
 */
export const modelTestResultSchema = z.object({
  modality: z.string(),
  /** The channel the probe actually ran against. */
  channelId: z.string(),
  providerType: z.string(),
  connectivity: modelTestCheckSchema,
  functional: modelTestCheckSchema,
  /** A small successful-output sample for operator confirmation (text excerpt or asset URL). */
  sample: z.object({ text: z.string().optional(), url: z.string().optional() }).optional(),
  /** Total probe wall-clock in milliseconds. */
  elapsedMs: z.number().int().nonnegative(),
});
export type ModelTestResult = z.infer<typeof modelTestResultSchema>;
