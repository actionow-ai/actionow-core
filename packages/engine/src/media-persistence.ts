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
const SINGLE_URL_KEYS = ['image_url', 'video_url', 'audio_url'] as const;
/** The output keys that carry an array of media URLs. */
const ARRAY_URL_KEYS = ['image_urls'] as const;

/** Default extension per content-type when a URL has no usable suffix. */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
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
 * Copy EACH distinct media URL in `output` into R2 and rewrite the output to the
 * stable `{publicBaseUrl}/{key}` URLs. A single media URL (one image / one video)
 * is stored under `{tenantId}/{jobId}.{ext}`; a batch of N DISTINCT images is
 * stored under `{tenantId}/{jobId}-{i}.{ext}` (one object each — a batch is NOT
 * collapsed to one object), and `image_urls` is rewritten element-wise while the
 * single `image_url` key maps to the first image. Best-effort: any error leaves
 * `output` untouched and reports `persisted: false` so the job still settles with
 * the temp upstream URL.
 */
export async function persistMediaOutput(input: PersistMediaInput): Promise<PersistMediaResult> {
  const { output } = input;
  const sources = distinctMediaUrls(output);
  if (sources.length === 0) {
    return { persisted: false, output, objects: [] };
  }

  try {
    const single = sources.length === 1;
    // Map each distinct upstream URL to its persisted public URL.
    const map = new Map<string, string>();
    const objects: PersistedObject[] = [];
    for (let i = 0; i < sources.length; i += 1) {
      const src = sources[i];
      if (src === undefined) continue;
      const fetched = await input.fetchBytes(src);
      const ext = extOf(src, fetched.contentType);
      const key = single
        ? `${input.tenantId}/${input.jobId}.${ext}`
        : `${input.tenantId}/${input.jobId}-${String(i)}.${ext}`;
      const presign = await input.storage.presignPut(
        key,
        fetched.contentType !== undefined ? { contentType: fetched.contentType } : {},
      );
      await input.putBytes(presign.url, fetched.bytes, fetched.contentType);
      map.set(src, `${input.publicBaseUrl}/${key}`);
      const object: PersistedObject = { key, size: fetched.bytes.byteLength };
      if (fetched.contentType !== undefined) object.contentType = fetched.contentType;
      objects.push(object);
    }

    const firstObj = objects[0];
    const first = firstObj !== undefined ? `${input.publicBaseUrl}/${firstObj.key}` : undefined;
    const rewritten: Record<string, unknown> = { ...output };
    for (const k of SINGLE_URL_KEYS) {
      const v = rewritten[k];
      if (typeof v === 'string') rewritten[k] = map.get(v) ?? first ?? v;
    }
    for (const k of ARRAY_URL_KEYS) {
      const arr = rewritten[k];
      if (Array.isArray(arr)) {
        rewritten[k] = (arr as unknown[]).map((u) =>
          typeof u === 'string' ? (map.get(u) ?? first ?? u) : u,
        );
      }
    }
    return { persisted: true, output: rewritten, objects };
  } catch {
    // Best-effort: settle with the temp URL rather than failing the job.
    return { persisted: false, output, objects: [] };
  }
}

/**
 * The distinct media URLs in `output`, ARRAY keys first (so `image_urls[0]` is
 * index 0) then the single keys, de-duplicated preserving first-seen order — so
 * `image_url == image_urls[0]` is downloaded/uploaded once, not twice.
 */
function distinctMediaUrls(output: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown): void => {
    if (typeof u === 'string' && u.length > 0 && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  for (const k of ARRAY_URL_KEYS) {
    const arr = output[k];
    if (Array.isArray(arr)) for (const u of arr) push(u);
  }
  for (const k of SINGLE_URL_KEYS) push(output[k]);
  return urls;
}
