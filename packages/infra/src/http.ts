import type { HttpClient, HttpRequest, HttpResponse } from '@actionow/contracts';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `HttpClient` backed by the Node 24 global `fetch`.
 *
 * - Enforces a per-request timeout via `AbortController` (defaults to 30s).
 * - Parses the response body as JSON when the `content-type` advertises JSON,
 *   guarding parse failures by leaving `body` undefined.
 * - Always captures the raw response `text` so callers can map upstream errors.
 */
export class FetchHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const headers: Record<string, string> = { ...req.headers };
      let body: string | undefined;
      if (req.body !== undefined) {
        body = JSON.stringify(req.body);
        if (!('content-type' in headers) && !('Content-Type' in headers)) {
          headers['content-type'] = 'application/json';
        }
      }

      const init: RequestInit = {
        method: req.method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = body;
      }

      const res = await fetch(req.url, init);
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
}

/** Shared singleton for production wiring. */
export const fetchHttpClient = new FetchHttpClient();
