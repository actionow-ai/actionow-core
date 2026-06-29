import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  UnifiedError,
} from '@actionow/contracts';
import { ProxyAgent } from 'undici';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default inter-chunk idle timeout for `stream()` (ms). LLM streams emit tokens
 * continuously once generation starts; a 2-minute gap with NO bytes (including
 * time-to-first-byte) means the upstream has stalled. Bounds the hang so a hung
 * provider can't pin the SSE connection + credit hold until the 15-min reaper.
 */
const DEFAULT_STREAM_IDLE_MS = 120_000;

/**
 * Thrown by `stream()` when the upstream sends no bytes within the idle window.
 * Carries a `unified` payload so the engine maps it to a retryable
 * `upstream_timeout` (its `toUnified` reads `.unified`).
 */
export class StreamIdleTimeoutError extends Error {
  readonly unified: UnifiedError;

  constructor(idleMs: number) {
    super(`upstream stream idle for ${String(idleMs)}ms`);
    this.name = 'StreamIdleTimeoutError';
    this.unified = {
      code: 'upstream_timeout',
      message: 'upstream stream stalled (idle timeout)',
      retryable: true,
    };
  }
}

/**
 * The undici `dispatcher` is exposed on `RequestInit` by the Node global-fetch
 * types, but those types come from a separate `undici-types` package whose
 * `Dispatcher` shape can drift from the `undici` package we construct the
 * `ProxyAgent` from. Bridge the two universes at this single field rather than
 * pinning the two independently-published type packages together.
 */
type FetchInit = Omit<RequestInit, 'dispatcher'> & { dispatcher?: ProxyAgent };

/**
 * Build the `fetch` `RequestInit` shared by buffered and streaming requests:
 * JSON-serialize a body and default the `content-type` header when one is set.
 *
 * When an `agent` is supplied it is attached as the undici `dispatcher` so the
 * request egresses through the per-request proxy.
 */
function buildInit(
  req: HttpRequest,
  agent: ProxyAgent | undefined,
  signal?: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = { ...req.headers };
  // A FormData body (multipart upload, e.g. the STT /v1/audio/transcriptions
  // relay) is passed through UNTOUCHED: `fetch` streams it and sets the
  // `multipart/form-data; boundary=…` content-type itself, so we must NOT
  // JSON.stringify it nor force an `application/json` header (either would
  // corrupt the boundary). Everything else is JSON-serialized as before.
  let body: string | FormData | undefined;
  if (req.body instanceof FormData) {
    body = req.body;
  } else if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    if (!('content-type' in headers) && !('Content-Type' in headers)) {
      headers['content-type'] = 'application/json';
    }
  }

  const init: FetchInit = { method: req.method, headers };
  if (signal !== undefined) {
    init.signal = signal;
  }
  if (body !== undefined) {
    init.body = body;
  }
  if (agent !== undefined) {
    init.dispatcher = agent;
  }
  // Bridge the `undici` ProxyAgent's `dispatcher` to the global-fetch RequestInit
  // (whose `dispatcher` comes from a separate undici-types version); see FetchInit.
  return init as unknown as RequestInit;
}

/**
 * Async-iterate a web `ReadableStream` of bytes as decoded UTF-8 text chunks.
 *
 * Uses a manual reader (rather than `for await (const c of body)`) so the
 * generator's `finally` can `releaseLock()` and `cancel()` the underlying
 * stream when the consumer stops early — preventing a leaked HTTP connection.
 */
async function* iterateUtf8(
  body: ReadableStream<Uint8Array>,
  idle?: { controller: AbortController; idleMs: number; firstChunkDeadline?: number },
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let first = true;
  try {
    for (;;) {
      // Each read is bounded by a timeout when configured: the FIRST chunk shares
      // ONE time-to-first-token budget with the header wait (`firstChunkDeadline`,
      // a wall-clock deadline so connection→first-token can't exceed TTFT), and
      // subsequent chunks use the inter-chunk idle window. On timeout the fetch is
      // aborted (tearing down the connection) and a StreamIdleTimeoutError is
      // thrown. The abandoned read is swallowed so its eventual rejection (from
      // the abort) is never unhandled.
      const readPromise = reader.read();
      let result: Awaited<typeof readPromise>;
      if (idle === undefined) {
        result = await readPromise;
      } else {
        const windowMs =
          first && idle.firstChunkDeadline !== undefined
            ? Math.max(1, idle.firstChunkDeadline - Date.now())
            : idle.idleMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            idle.controller.abort();
            reject(new StreamIdleTimeoutError(windowMs));
          }, windowMs);
        });
        try {
          result = await Promise.race([readPromise, timeout]);
        } catch (err) {
          void readPromise.catch(() => undefined);
          throw err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      first = false;
      const { done, value } = result;
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        yield text;
      }
    }
    // Flush any bytes buffered by the streaming decoder.
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    // `cancel()` tears down the upstream connection AND releases the lock — on
    // normal completion, consumer early-return, AND idle-timeout/abort. It also
    // resolves any read() left outstanding by a timed-out race (so no dangling
    // lock) and triggers the source's `cancel` (closing the socket).
    await reader.cancel().catch(() => undefined);
  }
}

/** An empty async iterable, for stream responses without a body. */
const emptyLines: AsyncIterable<string> = {
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
  },
};

/**
 * `HttpClient` backed by the Node 24 global `fetch`.
 *
 * - Enforces a per-request timeout via `AbortController` (defaults to 30s).
 * - Parses the response body as JSON when the `content-type` advertises JSON,
 *   guarding parse failures by leaving `body` undefined.
 * - Always captures the raw response `text` so callers can map upstream errors.
 */
export class FetchHttpClient implements HttpClient {
  /** One ProxyAgent per proxy URL, reused across requests. */
  private readonly proxyAgents = new Map<string, ProxyAgent>();

  /** Inter-chunk idle timeout for `stream()` (ms); per-request `idleTimeoutMs` overrides. */
  private readonly streamIdleTimeoutMs: number;

  constructor(opts: { streamIdleTimeoutMs?: number } = {}) {
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS;
  }

  /** Resolve (caching) the ProxyAgent for a proxy URL. */
  private agentFor(proxyUrl: string): ProxyAgent {
    let agent = this.proxyAgents.get(proxyUrl);
    if (agent === undefined) {
      agent = new ProxyAgent(proxyUrl);
      this.proxyAgents.set(proxyUrl, agent);
    }
    return agent;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    // NOTE: `req.connectTimeoutMs` is NOT separately enforced here — global fetch
    // has no per-request connect deadline; the whole-request `timeoutMs` bounds it.
    // The curl egress (CurlHttpClient) honors it via `--connect-timeout`.
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const agent = req.proxyUrl === undefined ? undefined : this.agentFor(req.proxyUrl);
      const res = await fetch(req.url, buildInit(req, agent, controller.signal));
      const text = await res.text();

      let parsed: unknown;
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.toLowerCase().includes('json')) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }

      return { status: res.status, ok: res.ok, body: parsed, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streaming variant of {@link request}. Issues the same `fetch` (body +
   * headers) but exposes the response body as an async iterable of decoded
   * UTF-8 text chunks instead of buffering it.
   *
   * No total timeout is applied — streaming responses are long-lived by design.
   * Instead an INTER-CHUNK idle timeout bounds a stalled upstream: the initial
   * fetch (time-to-headers) and each body read are aborted if no bytes arrive
   * within `idleTimeoutMs` (default {@link DEFAULT_STREAM_IDLE_MS}), so a hung
   * provider can't pin the SSE connection + credit hold until the reaper. The
   * consumer still controls lifetime by stopping iteration (cancels the reader).
   * Works on Node 24's undici `fetch`, whose `Response.body` is a web
   * `ReadableStream`.
   */
  async stream(req: HttpRequest): Promise<HttpStreamResponse> {
    const agent = req.proxyUrl === undefined ? undefined : this.agentFor(req.proxyUrl);
    const idleMs = req.idleTimeoutMs ?? this.streamIdleTimeoutMs;
    // Time-to-first-token: when set, ONE wall-clock deadline spans
    // connection→headers→first chunk, so the header wait and the first body read
    // share a single TTFT budget (not 2× the window). The header wait uses the
    // remaining budget; absent TTFT → the header wait + first chunk fall back to
    // the inter-chunk idle window (legacy behavior).
    const firstChunkDeadline =
      req.firstChunkTimeoutMs !== undefined ? Date.now() + req.firstChunkTimeoutMs : undefined;
    const headerWindowMs = req.firstChunkTimeoutMs ?? idleMs;

    // Bound time-to-headers too: abort if the upstream accepts the connection
    // but never sends a response within the (remaining) TTFT window.
    const controller = new AbortController();
    const headerTimer = setTimeout(() => {
      controller.abort();
    }, headerWindowMs);
    let res: Response;
    try {
      res = await fetch(req.url, buildInit(req, agent, controller.signal));
    } finally {
      clearTimeout(headerTimer);
    }

    const lines =
      res.body === null
        ? emptyLines
        : iterateUtf8(res.body, {
            controller,
            idleMs,
            ...(firstChunkDeadline !== undefined ? { firstChunkDeadline } : {}),
          });
    return { status: res.status, ok: res.ok, lines };
  }
}

/** Shared singleton for production wiring. */
export const fetchHttpClient = new FetchHttpClient();
