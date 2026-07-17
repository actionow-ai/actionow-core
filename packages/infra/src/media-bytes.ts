/**
 * Timeout-bounded media byte-transfer helpers shared by the worker runtime and
 * the api callbacks service (both best-effort callers in the settle path).
 *
 * The fn shapes ({@link FetchBytes}/{@link PutBytes}) mirror the engine's
 * `media-persistence` hook types structurally — infra must not depend on engine
 * (§14.5 boundary), so these are defined locally and the engine's
 * `persistMediaOutput` accepts them by structural compatibility.
 *
 * model-supply-greenfield 批次4 slice5 — §9.4 字节路径加固 ADDS the streaming
 * transfer surface below ({@link streamUrlToPresignedPut} / {@link
 * putBytesHashed} / {@link createMediaTransfer}): SSRF egress guard BEFORE any
 * byte moves, a streaming pipe that NEVER buffers a known-length body in
 * memory (禁全量进内存), size-tiered timeouts (按体积分级超时), and an
 * incremental sha256 for the §9.4 public-track checksum. The legacy
 * whole-buffer helpers ({@link fetchBytesWithTimeout}/{@link
 * putBytesWithTimeout}) are UNTOUCHED — the old job-runner media path keeps
 * its exact behavior (双面并存零破坏).
 */
import { createHash } from 'node:crypto';

import { assertEgressAllowed } from './ssrf.js';

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

// --- §9.4 hardened streaming transfer (批次4 slice5) -------------------------------

/** Thrown for every transfer defect: SSRF block bubble-up, HTTP failure, timeout, cap breach. */
export class MediaTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaTransferError';
  }
}

/** §9.4 按体积分级超时 — the tier table (content-length driven). */
export interface TieredTransferTimeouts {
  /** Bodies ≤ this many bytes run under {@link TieredTransferTimeouts.smallMs}. */
  smallMaxBytes: number;
  smallMs: number;
  /** Bodies ≤ this many bytes run under {@link TieredTransferTimeouts.mediumMs}. */
  mediumMaxBytes: number;
  mediumMs: number;
  /** Bodies above mediumMaxBytes — and unknown-length bodies — run under this. */
  largeMs: number;
}

/** Default tiers: ≤16MiB→30s (images), ≤256MiB→3min (clips), above→10min (long video). */
export const MEDIA_TRANSFER_TIMEOUTS: TieredTransferTimeouts = {
  smallMaxBytes: 16 * 1024 * 1024,
  smallMs: 30_000,
  mediumMaxBytes: 256 * 1024 * 1024,
  mediumMs: 180_000,
  largeMs: 600_000,
};

/** Pick the body-phase timeout for a (possibly unknown) content length (§9.4 分级). */
export function transferTimeoutForSize(
  contentLength: number | undefined,
  tiers: TieredTransferTimeouts = MEDIA_TRANSFER_TIMEOUTS,
): number {
  if (contentLength === undefined) return tiers.largeMs;
  if (contentLength <= tiers.smallMaxBytes) return tiers.smallMs;
  if (contentLength <= tiers.mediumMaxBytes) return tiers.mediumMs;
  return tiers.largeMs;
}

/**
 * Unknown-length fallback buffer cap. S3-compatible presigned PUTs require a
 * Content-Length (chunked uploads are rejected), so a body WITHOUT a
 * content-length header cannot be pipe-streamed — it is buffered up to THIS
 * bound and refused beyond it. Bounded by construction: the 禁全量进内存 red
 * line concerns unbounded buffering; a hard-capped fallback is the 择稳
 * compromise for length-less upstreams (the common CDN media case always
 * carries a length and STREAMS).
 */
export const UNKNOWN_LENGTH_BUFFER_CAP_BYTES = 32 * 1024 * 1024;

/** SSRF-checked redirect-follow ceiling (each hop re-runs the egress guard). */
export const MAX_TRANSFER_REDIRECTS = 3;

/** What the source's response headers revealed — the presign callback's input. */
export interface StreamSourceInfo {
  contentType?: string | undefined;
  contentLength?: number | undefined;
}

/** Where to PUT: the presigned URL + the content-type the presign was SIGNED with. */
export interface StreamPutTarget {
  url: string;
  contentType?: string | undefined;
}

export interface StreamTransferOptions {
  /**
   * The SSRF egress guard run on the source URL (and every redirect hop)
   * BEFORE any byte moves; default {@link assertEgressAllowed} (strict).
   * Injectable for tests and for operator private-target opt-ins.
   */
  assertEgress?: ((url: string) => Promise<void>) | undefined;
  timeouts?: TieredTransferTimeouts | undefined;
  /** Unknown-length buffer cap; default {@link UNKNOWN_LENGTH_BUFFER_CAP_BYTES}. */
  maxUnknownLengthBytes?: number | undefined;
  /** Injectable fetch (tests); default global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
}

export interface StreamTransferResult {
  /** Total bytes moved. */
  bytes: number;
  /** The content type the object was stored under. */
  contentType?: string | undefined;
  /** Hex sha256 of the transferred bytes (§9.4 public-track checksum). */
  sha256: string;
}

function headerContentLength(res: Response): number | undefined {
  const raw = res.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Open the source URL with the SSRF guard applied to the INITIAL url and to
 * EVERY redirect hop (redirect: 'manual' — an unchecked 302 to
 * `http://169.254.169.254/` would otherwise bypass the guard entirely).
 */
async function openGuardedSource(
  sourceUrl: string,
  guard: (url: string) => Promise<void>,
  f: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let url = sourceUrl;
  for (let hop = 0; hop <= MAX_TRANSFER_REDIRECTS; hop++) {
    await guard(url); // §9.4 SSRF 前置 — never fetch before the verdict
    const res = await f(url, { signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location === null) {
        throw new MediaTransferError(
          `upstream redirect (HTTP ${String(res.status)}) without a Location header`,
        );
      }
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      throw new MediaTransferError(`upstream media fetch failed: HTTP ${String(res.status)}`);
    }
    return res;
  }
  throw new MediaTransferError(
    `upstream media fetch exceeded ${String(MAX_TRANSFER_REDIRECTS)} redirects`,
  );
}

/**
 * §9.4 hardened artifact retrieval: stream one upstream media URL into a
 * presigned PUT.
 *
 * - **SSRF 前置**: the egress guard runs on the source URL (and each redirect
 *   hop) BEFORE any fetch — artifact URLs are UNTRUSTED upstream data.
 * - **流式管道**: with a known content-length the response body is PIPED
 *   through a counting/hashing TransformStream straight into the PUT request
 *   (`duplex: 'half'`) — the body never materializes in memory. Without a
 *   length the body is buffered under a HARD cap (S3 presigned PUTs need
 *   Content-Length), never unboundedly.
 * - **分级超时**: headers phase runs under the small tier; the body+PUT phase
 *   under {@link transferTimeoutForSize} of the announced length.
 * - **checksum**: sha256 is computed incrementally while the bytes move.
 *
 * `putUrlFor` is called ONCE, after the source headers arrive, so the caller
 * presigns with the REAL content type (a presigned PUT is content-type-bound).
 */
export async function streamUrlToPresignedPut(
  sourceUrl: string,
  putUrlFor: (info: StreamSourceInfo) => Promise<StreamPutTarget>,
  opts: StreamTransferOptions = {},
): Promise<StreamTransferResult> {
  const guard = opts.assertEgress ?? ((url: string): Promise<void> => assertEgressAllowed(url));
  const f = opts.fetchImpl ?? fetch;
  const tiers = opts.timeouts ?? MEDIA_TRANSFER_TIMEOUTS;

  const controller = new AbortController();
  let timedOut: MediaTransferError | undefined;
  const arm = (ms: number, label: string): NodeJS.Timeout =>
    setTimeout(() => {
      timedOut = new MediaTransferError(`media transfer ${label} timed out after ${String(ms)}ms`);
      controller.abort(timedOut);
    }, ms);

  // Headers phase: bounded by the SMALL tier (a status line is never "large").
  let timer = arm(tiers.smallMs, 'headers phase');
  let res: Response;
  try {
    res = await openGuardedSource(sourceUrl, guard, f, controller.signal);
  } catch (err) {
    throw timedOut ?? err;
  } finally {
    clearTimeout(timer);
  }

  const contentLength = headerContentLength(res);
  const sourceContentType = res.headers.get('content-type') ?? undefined;
  const target = await putUrlFor({ contentType: sourceContentType, contentLength });
  const contentType = target.contentType ?? sourceContentType;

  // Body + PUT phase: §9.4 分级超时 on the ANNOUNCED size.
  timer = arm(transferTimeoutForSize(contentLength, tiers), 'body phase');
  try {
    const hash = createHash('sha256');
    let total = 0;
    const body = res.body;
    if (body === null) throw new MediaTransferError('upstream media response has no body');

    if (contentLength !== undefined) {
      // Known length → STREAMING PIPE (禁全量进内存): count + hash in flight.
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctl): void {
            hash.update(chunk);
            total += chunk.byteLength;
            ctl.enqueue(chunk);
          },
        }),
      );
      const putRes = await f(target.url, {
        method: 'PUT',
        headers: {
          ...(contentType !== undefined ? { 'content-type': contentType } : {}),
          'content-length': String(contentLength),
        },
        body: counted,
        signal: controller.signal,
        // Node/undici requires half-duplex for ReadableStream request bodies.
        duplex: 'half',
      });
      if (!putRes.ok) {
        throw new MediaTransferError(`storage PUT failed: HTTP ${String(putRes.status)}`);
      }
      if (total !== contentLength) {
        throw new MediaTransferError(
          `upstream body length mismatch: announced ${String(contentLength)}, received ${String(total)}`,
        );
      }
    } else {
      // Unknown length → HARD-CAPPED buffer (S3 PUTs need Content-Length).
      const cap = opts.maxUnknownLengthBytes ?? UNKNOWN_LENGTH_BUFFER_CAP_BYTES;
      const chunks: Uint8Array[] = [];
      const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          controller.abort();
          throw new MediaTransferError(
            `unknown-length upstream body exceeded the ${String(cap)}-byte buffer cap`,
          );
        }
        hash.update(value);
        chunks.push(value);
      }
      const putRes = await f(target.url, {
        method: 'PUT',
        headers: {
          ...(contentType !== undefined ? { 'content-type': contentType } : {}),
          'content-length': String(total),
        },
        body: Buffer.concat(chunks),
        signal: controller.signal,
      });
      if (!putRes.ok) {
        throw new MediaTransferError(`storage PUT failed: HTTP ${String(putRes.status)}`);
      }
    }

    return {
      bytes: total,
      ...(contentType !== undefined ? { contentType } : {}),
      sha256: hash.digest('hex'),
    };
  } catch (err) {
    throw timedOut ?? err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload in-memory bytes (b64-decoded inline assets) to a presigned PUT with
 * the small-tier timeout, returning the sha256 the §9.4 public track records.
 */
export async function putBytesHashed(
  putUrl: string,
  bytes: Uint8Array,
  contentType?: string,
  opts: StreamTransferOptions = {},
): Promise<{ bytes: number; sha256: string }> {
  const f = opts.fetchImpl ?? fetch;
  const tiers = opts.timeouts ?? MEDIA_TRANSFER_TIMEOUTS;
  const res = await f(putUrl, {
    method: 'PUT',
    headers: {
      ...(contentType !== undefined ? { 'content-type': contentType } : {}),
      'content-length': String(bytes.byteLength),
    },
    body: bytes,
    signal: AbortSignal.timeout(transferTimeoutForSize(bytes.byteLength, tiers)),
  });
  if (!res.ok) throw new MediaTransferError(`storage PUT failed: HTTP ${String(res.status)}`);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Bundle the two hardened transfer legs into the shape the engine's §7.5
 * persist hook consumes (`MediaTransfer` — structural compatibility, the
 * FetchBytes/PutBytes precedent: infra never imports engine).
 */
export function createMediaTransfer(opts: StreamTransferOptions = {}): {
  fromUrl: (
    sourceUrl: string,
    putUrlFor: (info: StreamSourceInfo) => Promise<StreamPutTarget>,
  ) => Promise<StreamTransferResult>;
  fromBytes: (
    putUrl: string,
    bytes: Uint8Array,
    contentType?: string,
  ) => Promise<{ bytes: number; sha256: string }>;
} {
  return {
    fromUrl: (sourceUrl, putUrlFor) => streamUrlToPresignedPut(sourceUrl, putUrlFor, opts),
    fromBytes: (putUrl, bytes, contentType) => putBytesHashed(putUrl, bytes, contentType, opts),
  };
}
