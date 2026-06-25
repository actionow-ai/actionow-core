import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@actionow/contracts';
import type { InsertRelayTraceInput } from '@actionow/db';

/**
 * The correlation context a {@link TracingHttpClient} stamps onto every row it
 * writes: the tenant/job/channel/provider this upstream call belongs to. All
 * optional — a call may be captured before each id is known.
 */
export interface TraceContext {
  tenantId?: string | undefined;
  jobId?: string | undefined;
  channelId?: string | undefined;
  providerType?: string | undefined;
  /** The per-request route tag (染色) this call was pinned to, when set; else undefined. */
  routeTag?: string | undefined;
}

/** The shape the sink receives. Mirrors the db `insertRelayTrace` input. */
export type TraceRow = InsertRelayTraceInput;

/** Best-effort sink the tracer hands each completed row to. */
export type TraceSink = (row: TraceRow) => void | Promise<void>;

/**
 * Header names (case-insensitive) whose VALUE is always a credential, redacted
 * wholesale to `[redacted]` so a real token is never persisted.
 */
const SECRET_HEADER_NAMES =
  /^(authorization|cookie|set-cookie|x-api-key|api-key|proxy-authorization)$/i;

/** Header names CONTAINING a secret-ish token are also redacted. */
const SECRET_HEADER_SUBSTRINGS = /(token|secret|apikey|api-key|auth)/i;

/** Query-param names whose VALUE is redacted in a stored url. */
const SECRET_QUERY_PARAMS = /(token|key|secret|sig|signature|password)/i;

const REDACTED = '[redacted]';

/**
 * Replace every secret-bearing header value with `[redacted]`, lowercasing the
 * keys so the match is order/case-insensitive. NEVER stores a real bearer
 * token. The body is stored as-is — it does not carry the credential.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[lower] =
      SECRET_HEADER_NAMES.test(lower) || SECRET_HEADER_SUBSTRINGS.test(lower) ? REDACTED : value;
  }
  return out;
}

/**
 * Parse the url and replace any query-param value whose NAME matches
 * {@link SECRET_QUERY_PARAMS} with `[redacted]`. A url that fails to parse is
 * returned unchanged (it carries no query string we can safely rewrite).
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.test(name)) {
        parsed.searchParams.set(name, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A serialized body capped at `maxBytes`, plus whether it was clipped. */
export interface Capped {
  value: string;
  truncated: boolean;
}

/**
 * Clip `s` to at most `maxBytes` UTF-8 bytes, flagging truncation. Slices by
 * code units (a cheap superset bound: a JS string of N code units is ≤ … but
 * we measure real bytes and slice conservatively so the result never exceeds
 * the cap).
 */
export function cap(s: string, maxBytes: number): Capped {
  if (Buffer.byteLength(s) <= maxBytes) return { value: s, truncated: false };
  // Slice down until the byte length fits (multi-byte chars at the boundary).
  let end = Math.min(s.length, maxBytes);
  while (end > 0 && Buffer.byteLength(s.slice(0, end)) > maxBytes) end -= 1;
  return { value: s.slice(0, end), truncated: true };
}

/** Serialize an arbitrary request/response body to a string for capture. */
function stringifyBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    // JSON.stringify only throws on circular refs / BigInt; capture a marker
    // rather than risk an unhelpful `[object Object]` from a base coercion.
    return '[unserializable body]';
  }
}

/** The response text, or the JSON-serialized parsed body, or undefined. */
function responseText(res: HttpResponse): string | undefined {
  if (res.text !== '') return res.text;
  return stringifyBody(res.body);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * An {@link HttpClient} decorator that records a full request/response AUDIT
 * TRACE of every upstream call at the choke point, then delegates to an inner
 * client. Wraps the engine's `ctx.http` when `RELAY_TRACE=full`. Recording is
 * strictly best-effort: a sink error never affects the delegated result, and
 * the tracer never swallows a real consumer/stream error.
 *
 * - `request`: times the inner call, builds a row (redacted headers/url, capped
 *   request+response bodies), fires the sink (awaited but error-swallowed), and
 *   returns the inner response. On an inner throw it records an `error` row,
 *   then rethrows.
 * - `stream`: tees the inner `lines` — forwarding EVERY line unchanged to the
 *   consumer while accumulating them (respecting `maxBytes`) — and writes the
 *   row in a `finally` (isStream, assembled raw SSE, status, latency). A
 *   consumer/stream error is recorded then rethrown, never swallowed.
 */
export class TracingHttpClient implements HttpClient {
  private readonly inner: HttpClient;
  private readonly sink: TraceSink;
  private readonly ctx: TraceContext;
  private readonly maxBytes: number;

  constructor(inner: HttpClient, sink: TraceSink, ctx: TraceContext, maxBytes: number) {
    this.inner = inner;
    this.sink = sink;
    this.ctx = ctx;
    this.maxBytes = maxBytes;
    // `stream` is optional on HttpClient; only expose ours when the inner can
    // stream, so capability detection (`http.stream !== undefined`) is honest.
    if (inner.stream === undefined) {
      // Drop our `stream` method so callers see the inner's (absent) capability.
      this.stream = undefined as unknown as TracingHttpClient['stream'];
    }
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const start = Date.now();
    const reqBody = cap(stringifyBody(req.body) ?? '', this.maxBytes);
    try {
      const res = await this.inner.request(req);
      const resBody = cap(responseText(res) ?? '', this.maxBytes);
      await this.emit({
        ...this.base(req, reqBody),
        responseStatus: res.status,
        responseBody: resBody.value,
        isStream: false,
        latencyMs: Date.now() - start,
        truncated: reqBody.truncated || resBody.truncated,
      });
      return res;
    } catch (err) {
      await this.emit({
        ...this.base(req, reqBody),
        isStream: false,
        latencyMs: Date.now() - start,
        error: errorMessage(err),
        truncated: reqBody.truncated,
      });
      throw err;
    }
  }

  async stream(req: HttpRequest): Promise<HttpStreamResponse> {
    if (this.inner.stream === undefined) {
      throw new Error('TracingHttpClient: inner client has no stream support');
    }
    const start = Date.now();
    const reqBody = cap(stringifyBody(req.body) ?? '', this.maxBytes);
    const res = await this.inner.stream(req);

    // Capture state shared between the tee generator and its `finally` writer.
    let assembled = '';
    let bodyTruncated = false;
    let streamError: string | undefined;

    const append = (line: string): void => {
      if (bodyTruncated) return;
      const next = assembled + line;
      if (Buffer.byteLength(next) > this.maxBytes) {
        assembled = cap(next, this.maxBytes).value;
        bodyTruncated = true;
      } else {
        assembled = next;
      }
    };

    // Arrow closure (lexical `this`) so the generator can write the row in its
    // `finally` without aliasing `this`.
    const writeRow = (): Promise<void> =>
      this.emit({
        ...this.base(req, reqBody),
        responseStatus: res.status,
        responseBody: assembled,
        isStream: true,
        latencyMs: Date.now() - start,
        ...(streamError !== undefined ? { error: streamError } : {}),
        truncated: reqBody.truncated || bodyTruncated,
      });

    const teed: AsyncIterable<string> = (async function* (): AsyncGenerator<string> {
      try {
        for await (const line of res.lines) {
          append(line);
          // Forward EVERY line unchanged to the consumer.
          yield line;
        }
      } catch (err) {
        // A consumer/stream error: record it, then rethrow (never swallow).
        streamError = errorMessage(err);
        throw err;
      } finally {
        await writeRow();
      }
    })();

    return { status: res.status, ok: res.ok, lines: teed };
  }

  /** The columns shared by request/stream rows (correlation + redacted req). */
  private base(req: HttpRequest, reqBody: Capped): TraceRow {
    return {
      tenantId: this.ctx.tenantId,
      jobId: this.ctx.jobId,
      channelId: this.ctx.channelId,
      providerType: this.ctx.providerType,
      routeTag: this.ctx.routeTag,
      method: req.method,
      url: redactUrl(req.url),
      requestHeaders: redactHeaders(req.headers),
      requestBody: req.body === undefined ? null : reqBody.value,
    };
  }

  /** Fire the sink, swallowing any error: tracing must never break the call. */
  private async emit(row: TraceRow): Promise<void> {
    try {
      await this.sink(row);
    } catch {
      // Best-effort audit: a sink failure never affects the relayed request.
    }
  }
}
