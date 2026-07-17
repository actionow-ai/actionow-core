import { z } from 'zod';

/**
 * Single source of truth for the DATA-PLANE wire contracts (`/v1/files`) — the
 * file surface an external developer's app drives. 批次6 D2: the legacy
 * `/v1/run` · `/v1/jobs` · `/v1/resources` contracts died with the old
 * execution world (the task paradigm's contracts live in gateway-requests/
 * gateway-views). Same contract-first pattern as the admin/console
 * `*-requests`/`*-views` files: the backend validates/`.parse()`s against
 * these and the frontend/SDK import the inferred TYPE only. Money is a
 * µcredit decimal STRING.
 */

// ----- request bodies -----

/** `POST /v1/files/presign-upload` — mint a presigned PUT for a client upload. */
export const presignUploadSchema = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size: z.number().int().positive(),
});
export type PresignUploadBody = z.infer<typeof presignUploadSchema>;

// ----- views -----

/**
 * `POST /v1/files/presign-upload` response: the presigned PUT + the new file id.
 * `public_url` is the object's stable, non-expiring public URL
 * (`{STORAGE_PUBLIC_BASE_URL}/{key}`) — the durable link the object will serve at
 * once uploaded — or `null` when no public base is configured (the deployment
 * only exposes expiring presigned GETs). Same scheme generated assets use, so a
 * client-uploaded artifact (e.g. a self-rendered mp4) gets a persistable URL
 * without having to reconstruct it from the raw `key`.
 */
export const presignUploadResultSchema = z.object({
  file_id: z.string(),
  upload_url: z.string(),
  key: z.string(),
  expires_in: z.number(),
  public_url: z.string().nullable(),
});
export type PresignUploadResult = z.infer<typeof presignUploadResultSchema>;

/**
 * A `file_object` reference — the `POST /v1/files/:id/confirm` response and each
 * row of the `GET /v1/files` keyset list. `created_at` is the keyset sort key.
 * `public_url` is the stable, non-expiring public URL (or `null` when no public
 * base is configured); see {@link presignUploadResultSchema}.
 */
export const fileViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  size: z.number().nullable(),
  content_type: z.string().nullable(),
  etag: z.string().nullable(),
  created_at: z.string(),
  public_url: z.string().nullable(),
});
export type FileView = z.infer<typeof fileViewSchema>;

/**
 * A presigned download grant (`GET /v1/files/:id/url`). `url` is the expiring
 * presigned GET; `public_url` is the stable, non-expiring public URL (or `null`
 * when no public base is configured) — use it when the object is web-served and
 * you want a durable link instead of a short-lived signature.
 */
export const fileUrlResultSchema = z.object({
  url: z.string(),
  expires_in: z.number(),
  public_url: z.string().nullable(),
});
export type FileUrlResult = z.infer<typeof fileUrlResultSchema>;
