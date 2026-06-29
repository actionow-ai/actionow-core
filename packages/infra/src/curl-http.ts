import { spawn } from 'node:child_process';

import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  UnifiedError,
} from '@actionow/contracts';

import { FetchHttpClient } from './http.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_MAX_MS = 300_000;
/** Sentinel appended by `-w` so we can split the status code off the body. */
const STATUS_SENTINEL = '\n__ACTIONOW_CURL_STATUS__:';

/**
 * A curl TRANSPORT/CONNECTION failure: the request never produced an HTTP
 * response (connection refused, DNS failure, connect/transfer timeout, TLS
 * handshake reset). curl signals these with a non-zero exit code and an
 * `%{http_code}` of `000`, NOT a real upstream status.
 *
 * Node's `fetch` egress THROWS a raw error for the same conditions, which the
 * engine treats as retryable (`isFailoverRetryable` default-true). To match that
 * semantics this error carries a `unified` payload with `retryable: true` so:
 *   - the engine's `toUnified`/`isUnifiedCarrier` maps it to a retryable
 *     `upstream_error`, and
 *   - `isFailoverRetryable` (which is NOT `instanceof AdapterError/EngineError`
 *     for this class → hits its default-true branch) enables CROSS-channel
 *     failover AND circuit-breaker `onFailure` recording for a dead channel.
 *
 * A genuine upstream HTTP 4xx/5xx is NOT this: curl returns the real status
 * code, so {@link CurlHttpClient.request} returns a normal {@link HttpResponse}
 * and the adapter maps the status (4xx → non-retryable) as before.
 */
export class CurlTransportError extends Error {
  readonly unified: UnifiedError;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CurlTransportError';
    this.unified = {
      code: 'upstream_error',
      message: `curl transport failure (exit ${String(exitCode)})`,
      retryable: true,
    };
  }
}

/** Serialize a JSON body + default the content-type (mirrors FetchHttpClient.buildInit). */
function bodyAndHeaders(req: HttpRequest): { body?: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...req.headers };
  if (req.body === undefined) return { headers };
  // The curl egress pipes a STRING body over stdin and cannot stream a multipart
  // FormData (which carries a binary boundary). JSON.stringify-ing it would emit
  // `"{}"` and silently corrupt the request, so reject it explicitly: multipart
  // relays (the STT /v1/audio/transcriptions upload) require the fetch egress.
  if (req.body instanceof FormData) {
    throw new CurlTransportError('curl egress cannot send a multipart FormData body', 0);
  }
  const body = JSON.stringify(req.body);
  if (!('content-type' in headers) && !('Content-Type' in headers)) {
    headers['content-type'] = 'application/json';
  }
  return { body, headers };
}

function headerArgs(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
}

/** `--connect-timeout <s>` when the request carries a TCP/TLS connect deadline (fault policy). */
function connectTimeoutArgs(req: HttpRequest): string[] {
  if (req.connectTimeoutMs === undefined) return [];
  return ['--connect-timeout', String(Math.max(1, Math.ceil(req.connectTimeoutMs / 1000)))];
}

/**
 * `HttpClient` that egresses via the `curl` binary (a child process) instead of
 * Node's `fetch`. A DEV/sandbox fallback for environments where Node's outbound
 * TLS is blocked/reset but `curl` is allowed (gated by `HTTP_EGRESS=curl`). The
 * body is piped over stdin (`--data-binary @-`) so no shell escaping is needed;
 * `spawn` is invoked WITHOUT a shell. Implements both buffered `request` and SSE
 * `stream` (needed by the codex/stream-only relays).
 */
export class CurlHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const { body, headers } = bodyAndHeaders(req);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = [
      '-sS',
      '-X',
      req.method,
      '--max-time',
      String(Math.ceil(timeoutMs / 1000)),
      ...connectTimeoutArgs(req),
      ...headerArgs(headers),
      ...(req.proxyUrl !== undefined ? ['-x', req.proxyUrl] : []),
      ...(body !== undefined ? ['--data-binary', '@-'] : []),
      '-w',
      `${STATUS_SENTINEL}%{http_code}`,
      req.url,
    ];

    const { stdout, stderr, code } = await runCurl(args, body);
    const idx = stdout.lastIndexOf(STATUS_SENTINEL);
    if (idx < 0) {
      // No status sentinel → curl never completed the HTTP transaction (e.g. the
      // process was killed). A TRANSPORT failure, not an upstream HTTP error.
      throw new CurlTransportError(
        `curl egress failed (exit ${String(code)}): ${stderr.slice(0, 300)}`,
        code,
      );
    }
    const text = stdout.slice(0, idx);
    const status = Number(stdout.slice(idx + STATUS_SENTINEL.length).trim());
    // `%{http_code}` is `000` (→ NaN/0 here) when curl never got an HTTP response:
    // connection refused, could-not-resolve-host, connect/transfer timeout, TLS
    // reset. These are TRANSPORT failures (curl exits non-zero) — surface them as
    // a RETRYABLE upstream error so cross-channel failover + the circuit breaker
    // engage, matching the Node-fetch egress (which throws for the same cases).
    // A real upstream status (incl. 4xx/5xx) is > 0 and falls through unchanged.
    if (!Number.isFinite(status) || status === 0) {
      throw new CurlTransportError(
        `curl egress could not reach upstream (exit ${String(code)}): ${stderr.slice(0, 300)}`,
        code,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status, ok: status >= 200 && status < 300, body: parsed, text };
  }

  async stream(req: HttpRequest): Promise<HttpStreamResponse> {
    const { body, headers } = bodyAndHeaders(req);
    const args = [
      '-sS',
      '-N', // unbuffered — emit bytes as they arrive (SSE)
      '-D',
      '-', // dump response headers to stdout (prefix) so we can read the status
      '-X',
      req.method,
      '--max-time',
      String(Math.ceil((req.idleTimeoutMs ?? DEFAULT_STREAM_MAX_MS) / 1000) || 300),
      ...connectTimeoutArgs(req),
      ...headerArgs(headers),
      ...(req.proxyUrl !== undefined ? ['-x', req.proxyUrl] : []),
      ...(body !== undefined ? ['--data-binary', '@-'] : []),
      req.url,
    ];

    const child = spawn('curl', args);
    if (body !== undefined) child.stdin.write(body);
    child.stdin.end();
    child.stderr.on('data', () => undefined);

    const chunks: string[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let errored: Error | null = null;
    let headerBuf = '';
    let headersDone = false;
    let resolveStatus: (s: number) => void = () => undefined;
    let rejectStatus: (e: Error) => void = () => undefined;
    const statusP = new Promise<number>((res, rej) => {
      resolveStatus = res;
      rejectStatus = rej;
    });
    const bump = (): void => {
      if (wake !== null) {
        wake();
        wake = null;
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (headersDone) {
        chunks.push(s);
        bump();
        return;
      }
      headerBuf += s;
      // Skip 1xx interim blocks; resolve on the first final status.
      let sep = headerBuf.indexOf('\r\n\r\n');
      while (sep >= 0) {
        const head = headerBuf.slice(0, sep);
        const m = /HTTP\/[\d.]+\s+(\d+)/.exec(head);
        const status = m ? Number(m[1]) : 0;
        if (status === 100) {
          headerBuf = headerBuf.slice(sep + 4);
          sep = headerBuf.indexOf('\r\n\r\n');
          continue;
        }
        headersDone = true;
        resolveStatus(status);
        const rest = headerBuf.slice(sep + 4);
        if (rest.length > 0) {
          chunks.push(rest);
          bump();
        }
        return;
      }
    });
    child.on('error', (e) => {
      errored = e;
      if (!headersDone) rejectStatus(e);
      bump();
    });
    child.on('close', (code) => {
      ended = true;
      // Closed before any HTTP response headers: curl never reached the upstream
      // (connect refused / DNS / connect timeout / TLS reset → non-zero exit).
      // Reject with a RETRYABLE transport error (matching `request()` + the Node
      // fetch egress, which throws) so failover + the breaker engage, rather than
      // surfacing a phantom status-0 response the relay would map non-retryably.
      if (!headersDone) {
        if (code !== 0 && code !== null) {
          rejectStatus(new CurlTransportError(`curl stream could not reach upstream`, code));
        } else {
          resolveStatus(0);
        }
      }
      bump();
    });

    const status = await statusP;
    async function* lines(): AsyncIterable<string> {
      try {
        for (;;) {
          const next = chunks.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (ended) {
            if (errored !== null) throw errored;
            return;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      } finally {
        child.kill();
      }
    }
    return { status, ok: status >= 200 && status < 300, lines: lines() };
  }
}

/**
 * The production HTTP client, with a DEV egress escape hatch: `HTTP_EGRESS=curl`
 * routes all platform egress through the `curl` binary instead of Node `fetch` —
 * for sandboxes where Node's outbound TLS is blocked but curl is allowed. Default
 * (and production) is the undici-backed {@link FetchHttpClient}.
 */
export function createHttpClient(opts: { streamIdleTimeoutMs?: number } = {}): HttpClient {
  if (process.env.HTTP_EGRESS === 'curl') return new CurlHttpClient();
  return new FetchHttpClient(opts);
}

/** Run `curl` to completion, buffering stdout/stderr; body (if any) is piped to stdin. */
function runCurl(
  args: string[],
  body?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (body !== undefined) child.stdin.write(body);
    child.stdin.end();
  });
}
