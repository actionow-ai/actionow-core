/**
 * Timeout-bounded media byte-transfer helpers shared by the worker runtime and
 * the api callbacks service (both best-effort callers in the settle path).
 *
 * The fn shapes ({@link FetchBytes}/{@link PutBytes}) mirror the engine's
 * `media-persistence` hook types structurally — infra must not depend on engine
 * (§14.5 boundary), so these are defined locally and the engine's
 * `persistMediaOutput` accepts them by structural compatibility.
 */

/** The bytes + content type fetched from an upstream media URL. */
export interface FetchedBytes {
  bytes: Uint8Array;
  contentType?: string;
}

/** Download an upstream media URL's bytes (injected). */
export type FetchBytes = (url: string) => Promise<FetchedBytes>;
/** Upload bytes to a presigned PUT URL (injected). */
export type PutBytes = (url: string, bytes: Uint8Array, contentType?: string) => Promise<void>;

/** Upper bound (ms) on a single upstream media transfer before it is aborted. */
export const MEDIA_FETCH_TIMEOUT_MS = 30_000;

/**
 * Default {@link FetchBytes}: download an upstream media URL over global `fetch`,
 * bounded by an `AbortSignal.timeout` so a hanging upstream can never stall the
 * settle path. Returns the raw bytes + content type.
 */
export const fetchBytesWithTimeout: FetchBytes = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? undefined;
  return contentType === undefined ? { bytes } : { bytes, contentType };
};

/** Default {@link PutBytes}: upload bytes to a presigned PUT URL over global `fetch`. */
export const putBytesWithTimeout: PutBytes = async (url, bytes, contentType) => {
  await fetch(url, {
    method: 'PUT',
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    body: bytes,
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
};
