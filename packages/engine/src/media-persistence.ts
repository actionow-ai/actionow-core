import type { StorageProvider } from '@actionow/contracts';

/** The bytes + content type fetched from an upstream media URL. */
export interface FetchedBytes {
  bytes: Uint8Array;
  contentType?: string;
}

/** Upload bytes to a presigned PUT URL (injected so the engine stays infra-free). */
export type PutBytes = (url: string, bytes: Uint8Array, contentType?: string) => Promise<void>;
/** Download an upstream media URL's bytes (injected). */
export type FetchBytes = (url: string) => Promise<FetchedBytes>;

/** A persisted R2 object the caller turns into a `file_object` row. */
export interface PersistedObject {
  key: string;
  contentType?: string;
  size?: number;
}

export interface PersistMediaInput {
  storage: StorageProvider;
  /** The R2 public custom-domain base (e.g. https://asset.actionow.ai). */
  publicBaseUrl: string;
  fetchBytes: FetchBytes;
  putBytes: PutBytes;
  tenantId: string;
  jobId: string;
  output: Record<string, unknown>;
}

export interface PersistMediaResult {
  /** True iff at least one media URL was copied into R2 and rewritten. */
  persisted: boolean;
  /** The (possibly rewritten) output; identical to input.output when not persisted. */
  output: Record<string, unknown>;
  objects: PersistedObject[];
}

/** The output keys that may carry an upstream media URL (single value). */
const SINGLE_URL_KEYS = ['image_url', 'video_url'] as const;
/** The output keys that carry an array of media URLs. */
const ARRAY_URL_KEYS = ['image_urls'] as const;

/** Default extension per content-type when a URL has no usable suffix. */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

/** Best-effort: derive a file extension from a URL path, then content-type, else 'bin'. */
function extOf(url: string, contentType?: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    if (dot > 0 && dot < path.length - 1) {
      const ext = path.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
    }
  } catch {
    // fall through to content-type
  }
  if (contentType !== undefined && EXT_BY_CONTENT_TYPE[contentType] !== undefined) {
    return EXT_BY_CONTENT_TYPE[contentType];
  }
  return 'bin';
}

/**
 * Copy any media URL(s) in `output` into R2 under `{tenantId}/{jobId}.{ext}` and
 * rewrite them to the stable `{publicBaseUrl}/{key}` URL. ALL media URLs that share
 * one modality point at the SAME object (image_url == image_urls[0]), so a single
 * download+upload is reused. Best-effort: any error leaves `output` untouched and
 * reports `persisted: false` so the job still settles with the temp URL.
 */
export async function persistMediaOutput(input: PersistMediaInput): Promise<PersistMediaResult> {
  const { output } = input;
  // Find the first present media URL (single keys take priority, else array[0]).
  const sourceUrl = firstMediaUrl(output);
  if (sourceUrl === undefined) {
    return { persisted: false, output, objects: [] };
  }

  try {
    const fetched = await input.fetchBytes(sourceUrl);
    const ext = extOf(sourceUrl, fetched.contentType);
    const key = `${input.tenantId}/${input.jobId}.${ext}`;
    const presign = await input.storage.presignPut(
      key,
      fetched.contentType !== undefined ? { contentType: fetched.contentType } : {},
    );
    await input.putBytes(presign.url, fetched.bytes, fetched.contentType);

    const publicUrl = `${input.publicBaseUrl}/${key}`;
    const rewritten: Record<string, unknown> = { ...output };
    for (const k of SINGLE_URL_KEYS) {
      if (typeof rewritten[k] === 'string') rewritten[k] = publicUrl;
    }
    for (const k of ARRAY_URL_KEYS) {
      if (Array.isArray(rewritten[k]))
        rewritten[k] = (rewritten[k] as unknown[]).map(() => publicUrl);
    }
    const object: PersistedObject = { key, size: fetched.bytes.byteLength };
    if (fetched.contentType !== undefined) object.contentType = fetched.contentType;
    return {
      persisted: true,
      output: rewritten,
      objects: [object],
    };
  } catch {
    // Best-effort: settle with the temp URL rather than failing the job.
    return { persisted: false, output, objects: [] };
  }
}

/** The first present media URL in an output, or undefined. */
function firstMediaUrl(output: Record<string, unknown>): string | undefined {
  for (const k of SINGLE_URL_KEYS) {
    const v = output[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const k of ARRAY_URL_KEYS) {
    const arr = output[k];
    if (Array.isArray(arr) && typeof arr[0] === 'string') return arr[0];
  }
  return undefined;
}
