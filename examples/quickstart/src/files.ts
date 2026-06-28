import { type DataPlaneClient, dataPlaneClient } from './client.js';

/**
 * Object storage via core's presigned-URL flow. Core owns the bucket; your app
 * never holds storage credentials. The lifecycle is three control calls around
 * one direct-to-storage transfer:
 *
 *   1. `POST /v1/files/presign-upload` → a `file_id` + a short-lived `upload_url`.
 *   2. PUT the bytes straight to `upload_url` (this hits the storage provider,
 *      NOT core — so it does not consume an API request or credits).
 *   3. `POST /v1/files/:id/confirm` → core HEADs the object and marks it `ready`.
 *
 * The returned `file_id` is core's stable handle: pass it as a `file` input to a
 * run (img2img, etc.), and store it in YOUR app DB to reference the asset later.
 * Download is symmetric: `GET /v1/files/:id/url` mints a presigned GET URL.
 *
 * Files are subject-scoped when the `ak_…` key is subject-scoped, so an end-user
 * can only ever see their own uploads.
 */

/** Upload a buffer through the presign→PUT→confirm flow; returns the core `file_id`. */
export async function uploadFile(
  baseUrl: string,
  apiKey: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const client: DataPlaneClient = dataPlaneClient(baseUrl, apiKey);

  // 1. Mint the presigned PUT. `size` is validated against the platform max.
  const presign = await client.POST('/v1/files/presign-upload', {
    body: { filename, content_type: contentType, size: bytes.byteLength },
  });
  if (presign.error !== undefined) {
    throw new Error(`presign failed: ${String(presign.response.status)}`);
  }
  const { file_id, upload_url } = presign.data;

  // 2. PUT the bytes directly to storage (the presigned URL is the storage host).
  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`upload PUT failed: ${String(put.status)}`);
  }

  // 3. Confirm: core HEADs the object and flips the file to `ready`.
  const confirm = await client.POST('/v1/files/{id}/confirm', {
    params: { path: { id: file_id } },
  });
  if (confirm.error !== undefined) {
    throw new Error(`confirm failed: ${String(confirm.response.status)}`);
  }

  return file_id;
}

/** Mint a presigned GET URL for a stored file (e.g. to stream a generated asset to a browser). */
export async function downloadUrl(
  baseUrl: string,
  apiKey: string,
  fileId: string,
): Promise<{ url: string; expires_in: number }> {
  const client: DataPlaneClient = dataPlaneClient(baseUrl, apiKey);

  const { data, error, response } = await client.GET('/v1/files/{id}/url', {
    params: { path: { id: fileId } },
  });
  if (error !== undefined) {
    throw new Error(`download url failed: ${String(response.status)}`);
  }
  return data;
}
