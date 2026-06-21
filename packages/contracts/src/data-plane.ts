import { z } from 'zod';

import { EXEC_MODES } from './adapter.js';

/**
 * Single source of truth for the DATA-PLANE wire contracts (`/v1/run`, `/v1/jobs`,
 * `/v1/resources`, `/v1/files`) — the generation hot path an external developer's
 * app drives. Same contract-first pattern as the admin/console `*-requests`/`*-views`
 * files: the backend validates/`.parse()`s against these and the frontend/SDK import
 * the inferred TYPE only. These flow into `openapi.json` → `@actionow/sdk` so the
 * submit → poll → download loop is typed. Money is a µcredit decimal STRING.
 */

// ----- request bodies -----

/**
 * `POST /v1/run/:resourceId` — run a resource. `inputs` is the resource's io_schema
 * payload (a `file` input carries a `file_id` the run resolves to a URL). `exec_mode`
 * picks blocking/stream/async; `callback_url` (http(s)) receives the async webhook;
 * `estimated_usage` pre-declares the metered dims for the credit hold. Unknown
 * top-level keys are stripped by the controller.
 */
export const runBodySchema = z.object({
  inputs: z.record(z.unknown()).optional(),
  exec_mode: z.enum(EXEC_MODES).optional(),
  callback_url: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'callback_url must be an http(s) URL',
    })
    .optional(),
  idempotency_key: z.string().min(1).optional(),
  end_user: z.string().optional(),
  estimated_usage: z.record(z.number()).optional(),
});
export type RunBody = z.infer<typeof runBodySchema>;

/** `POST /v1/files/presign-upload` — mint a presigned PUT for a client upload. */
export const presignUploadSchema = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size: z.number().int().positive(),
});
export type PresignUploadBody = z.infer<typeof presignUploadSchema>;

// ----- views -----

/** Money on the data plane: a µcredit decimal **string**. */
const costSchema = z.object({ credits: z.string() });

/**
 * `POST /v1/run/:resourceId` response. `status` is `queued` (async → poll
 * `/v1/jobs/:id`) or `succeeded` (blocking → `output`/`usage`/`cost` inline).
 */
export const runResponseSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  usage: z.unknown().optional(),
  cost: costSchema.optional(),
});
export type RunResponse = z.infer<typeof runResponseSchema>;

/**
 * A job as served by `GET /v1/jobs[/:id]` (the data-plane view — distinct from the
 * admin `JobView`). `inputs`/`output`/`usage`/`error` are free-form per resource;
 * `cost` is `{ credits }` (µcredit string) once settled, else `null`.
 */
export const runJobViewSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  resource_id: z.string(),
  exec_mode: z.string(),
  inputs: z.unknown(),
  output: z.unknown(),
  usage: z.unknown(),
  cost: costSchema.nullable(),
  error: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type RunJobView = z.infer<typeof runJobViewSchema>;

/** A resource as served by `GET /v1/resources` (discovery list). */
export const resourceSummarySchema = z.object({
  id: z.string(),
  kind: z.string(),
  modality: z.string(),
  provider_type: z.string(),
  exec_modes: z.array(z.string()),
});
export type ResourceSummary = z.infer<typeof resourceSummarySchema>;

/** A resource with its io_schema + active pricing (`GET /v1/resources/:id`). */
export const resourceDetailSchema = resourceSummarySchema.extend({
  io_schema: z.unknown(),
  pricing: z.object({ method: z.string(), timing: z.string(), spec: z.unknown() }).optional(),
});
export type ResourceDetail = z.infer<typeof resourceDetailSchema>;

/** `POST /v1/files/presign-upload` response: the presigned PUT + the new file id. */
export const presignUploadResultSchema = z.object({
  file_id: z.string(),
  upload_url: z.string(),
  key: z.string(),
  expires_in: z.number(),
});
export type PresignUploadResult = z.infer<typeof presignUploadResultSchema>;

/**
 * A `file_object` reference — the `POST /v1/files/:id/confirm` response and each
 * row of the `GET /v1/files` keyset list. `created_at` is the keyset sort key.
 */
export const fileViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  size: z.number().nullable(),
  content_type: z.string().nullable(),
  etag: z.string().nullable(),
  created_at: z.string(),
});
export type FileView = z.infer<typeof fileViewSchema>;

/** A presigned download grant (`GET /v1/files/:id/url`). */
export const fileUrlResultSchema = z.object({
  url: z.string(),
  expires_in: z.number(),
});
export type FileUrlResult = z.infer<typeof fileUrlResultSchema>;
