import type { Asset, MediaResult, StorageProvider } from '@actionow/contracts';

// Reuse the byte-IO hook types from the legacy module (removed in P1 Task 9) so
// the barrel doesn't re-export colliding names while both modules coexist.
import type { FetchBytes, FetchedBytes, PutBytes } from './media-persistence.js';

/** A persisted R2 object the caller turns into a `file_object` row (P1: + media dims). */
export interface PersistedMediaObject {
  key: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface PersistMediaResultInput {
  storage: StorageProvider;
  /** The R2 public custom-domain base (e.g. https://asset.actionow.ai). */
  publicBaseUrl: string;
  fetchBytes: FetchBytes;
  putBytes: PutBytes;
  tenantId: string;
  jobId: string;
  /** The canonical media result whose assets are copied into durable storage. */
  result: MediaResult;
}

export interface PersistMediaResultOutput {
  /** True iff at least one asset was copied into R2 and rewritten. */
  persisted: boolean;
  /** The (possibly rewritten) result; identical to input.result when not persisted. */
  result: MediaResult;
  objects: PersistedMediaObject[];
}

/** Default extension per content-type / mime when a URL has no usable suffix. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'model/gltf-binary': 'glb',
};

/** Derive a file extension from a URL path, then the content-type/mime, else 'bin'. */
function extOf(url: string | undefined, mime: string | undefined): string {
  if (url !== undefined) {
    try {
      const path = new URL(url).pathname;
      const dot = path.lastIndexOf('.');
      if (dot > 0 && dot < path.length - 1) {
        const ext = path.slice(dot + 1).toLowerCase();
        if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
      }
    } catch {
      // fall through to mime
    }
  }
  if (mime !== undefined && EXT_BY_MIME[mime] !== undefined) return EXT_BY_MIME[mime];
  return 'bin';
}

/** Source one asset's bytes — fetched from its `url`, else decoded from its `b64`. */
async function sourceBytes(asset: Asset, fetchBytes: FetchBytes): Promise<FetchedBytes> {
  if (asset.url !== undefined) return fetchBytes(asset.url);
  if (asset.b64 !== undefined) {
    return { bytes: new Uint8Array(Buffer.from(asset.b64, 'base64')), contentType: asset.mime };
  }
  throw new Error('asset has neither url nor b64');
}

/**
 * Copy EACH asset in a {@link MediaResult} into R2 and rewrite it to the stable
 * `{publicBaseUrl}/{key}` URL. A single asset is stored under
 * `{tenantId}/{jobId}.{ext}`; a batch of N assets under
 * `{tenantId}/{jobId}-{i}.{ext}` (one object each). Inline `b64` bytes are
 * decoded, uploaded, and DROPPED from the rewritten asset (durable URL replaces
 * them). Best-effort: any error leaves `result` untouched and reports
 * `persisted: false`, so the job still settles with the temp upstream URL.
 *
 * This is the SINGLE owner of media persistence (supersedes the URL-keyed
 * `persistMediaOutput`); the caller writes one `file_object` per returned object.
 */
export async function persistMediaResult(
  input: PersistMediaResultInput,
): Promise<PersistMediaResultOutput> {
  const { result } = input;
  if (result.assets.length === 0) {
    return { persisted: false, result, objects: [] };
  }

  try {
    const single = result.assets.length === 1;
    const objects: PersistedMediaObject[] = [];
    const rewritten: Asset[] = [];

    for (let i = 0; i < result.assets.length; i += 1) {
      const asset = result.assets[i];
      if (asset === undefined) continue;
      const fetched = await sourceBytes(asset, input.fetchBytes);
      const contentType = fetched.contentType ?? asset.mime;
      const ext = extOf(asset.url, contentType);
      const key = single
        ? `${input.tenantId}/${input.jobId}.${ext}`
        : `${input.tenantId}/${input.jobId}-${String(i)}.${ext}`;
      const presign = await input.storage.presignPut(key, { contentType });
      await input.putBytes(presign.url, fetched.bytes, contentType);

      const durableUrl = `${input.publicBaseUrl}/${key}`;
      const size = fetched.bytes.byteLength;
      // Rewrite: durable url replaces url/b64; mime/size refreshed; metadata kept.
      const nextAsset: Asset = { ...asset, url: durableUrl, mime: contentType, size };
      delete nextAsset.b64;
      rewritten.push(nextAsset);

      const object: PersistedMediaObject = { key, contentType, size };
      if (asset.width !== undefined) object.width = asset.width;
      if (asset.height !== undefined) object.height = asset.height;
      if (asset.duration !== undefined) object.duration = asset.duration;
      objects.push(object);
    }

    return { persisted: true, result: { ...result, assets: rewritten }, objects };
  } catch {
    // Best-effort: settle with the temp upstream URL rather than failing the job.
    return { persisted: false, result, objects: [] };
  }
}

/**
 * provider_cost (µUSD, integer bigint) = Σ usage[dim] × costPerUnit[dim]. Returns
 * `undefined` when no per-unit cost is configured on the channel (unknown cost →
 * a NULL provider_cost, not a zero). Unknown usage dimensions contribute nothing.
 */
export function meterMedia(
  usage: Record<string, number>,
  costPerUnit: Record<string, number> | undefined,
): bigint | undefined {
  if (costPerUnit === undefined) return undefined;
  let total = 0n;
  for (const [dim, n] of Object.entries(usage)) {
    const unit = costPerUnit[dim];
    if (typeof unit === 'number') total += BigInt(Math.round(n * unit));
  }
  return total;
}
