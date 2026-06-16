import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@actionow/contracts';
import { ProxyAgent } from 'undici';

const DEFAULT_TIMEOUT_MS = 30_000;

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
  let body: string | undefined;
  if (req.body !== undefined) {
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
async function* iterateUtf8(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    // Releasing then cancelling tears down the upstream connection on early
    // return (consumer `break`/`return`) as well as normal completion.
    reader.releaseLock();
    await body.cancel().catch(() => undefined);
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
   * No request timeout is applied — streaming responses are long-lived by
   * design; the consumer controls lifetime by stopping iteration (which
   * releases and cancels the underlying reader). Works on Node 24's undici
   * `fetch`, whose `Response.body` is a web `ReadableStream`.
   */
  async stream(req: HttpRequest): Promise<HttpStreamResponse> {
    const agent = req.proxyUrl === undefined ? undefined : this.agentFor(req.proxyUrl);
    const res = await fetch(req.url, buildInit(req, agent));
    const lines = res.body === null ? emptyLines : iterateUtf8(res.body);
    return { status: res.status, ok: res.ok, lines };
  }
}

/** Shared singleton for production wiring. */
export const fetchHttpClient = new FetchHttpClient();
