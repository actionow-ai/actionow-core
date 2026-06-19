export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /**
   * Inter-chunk idle timeout for `stream()` (ms): a stalled upstream that sends
   * no bytes within this window (incl. time-to-first-byte) is aborted so a hung
   * provider can't pin the SSE connection + credit hold. Defaults to the client's
   * configured `streamIdleTimeoutMs`. Does not apply to buffered `request()`.
   */
  idleTimeoutMs?: number;
  /** Optional per-request HTTP(S) proxy URL; the FetchHttpClient routes via an undici ProxyAgent. */
  proxyUrl?: string;
}
export interface HttpResponse {
  status: number;
  ok: boolean;
  body: unknown; // parsed JSON when possible, else undefined
  text: string;
}
/**
 * Streaming counterpart of {@link HttpResponse}. The body is exposed as an
 * async iterable of decoded UTF-8 text chunks (not whole lines — chunks may
 * split lines arbitrarily); callers frame it themselves (e.g. SSE parsing).
 */
export interface HttpStreamResponse {
  status: number;
  ok: boolean;
  lines: AsyncIterable<string>;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Optional streaming variant; yields decoded UTF-8 chunks of the body. */
  stream?(req: HttpRequest): Promise<HttpStreamResponse>;
}
