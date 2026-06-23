import { spawn } from 'node:child_process';

import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@actionow/contracts';

import { FetchHttpClient } from './http.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_MAX_MS = 300_000;
/** Sentinel appended by `-w` so we can split the status code off the body. */
const STATUS_SENTINEL = '\n__ACTIONOW_CURL_STATUS__:';

/** Serialize a JSON body + default the content-type (mirrors FetchHttpClient.buildInit). */
function bodyAndHeaders(req: HttpRequest): { body?: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...req.headers };
  if (req.body === undefined) return { headers };
  const body = JSON.stringify(req.body);
  if (!('content-type' in headers) && !('Content-Type' in headers)) {
    headers['content-type'] = 'application/json';
  }
  return { body, headers };
}

function headerArgs(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
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
      // No status sentinel → curl never completed the HTTP transaction.
      throw new Error(`curl egress failed (exit ${String(code)}): ${stderr.slice(0, 300)}`);
    }
    const text = stdout.slice(0, idx);
    const status = Number(stdout.slice(idx + STATUS_SENTINEL.length).trim());
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
    child.on('close', () => {
      ended = true;
      if (!headersDone) resolveStatus(0);
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
