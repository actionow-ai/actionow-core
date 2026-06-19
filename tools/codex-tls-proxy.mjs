#!/usr/bin/env node
/**
 * codex-tls-proxy — TLS-egress sidecar for the codex-oauth relay channel.
 *
 * WHY THIS EXISTS
 * ---------------
 * The private Codex backend (`chatgpt.com/backend-api/codex`) sits behind
 * Cloudflare, which fingerprints the TLS ClientHello (JA3/JA4). Node's built-in
 * HTTP client (undici) presents a fingerprint Cloudflare REJECTS — the
 * connection is RESET before any HTTP response (`ECONNRESET`). A client with a
 * browser-like fingerprint (curl-impersonate) passes.
 *
 * Rather than embed TLS-fingerprint spoofing in the application, the relay keeps
 * its Node HTTP client and routes the ONE Cloudflare-fronted upstream through
 * this tiny sidecar: the relay speaks plain HTTP to `127.0.0.1:<PORT>`, and the
 * sidecar re-issues the request to the real origin via a `curl` binary whose
 * fingerprint passes. It is intentionally minimal and scoped to a SINGLE origin
 * (not an open proxy), bound to loopback only.
 *
 * This is for the operator relaying THEIR OWN paid ChatGPT/Codex subscription
 * (opt-in, BYO-account, ToS-acknowledged) — see docs and `ENABLE_OAUTH_CHANNELS`.
 *
 * CONFIG (env)
 * ------------
 *   PORT            loopback port to listen on            (default 8787)
 *   CODEX_CURL_BIN  curl binary to egress through         (default "curl")
 *   TARGET_ORIGIN   the single allowed upstream origin     (default https://chatgpt.com)
 *
 * PRODUCTION: set CODEX_CURL_BIN to a curl-impersonate wrapper (e.g.
 * `curl_chrome124`). The OS `curl` fingerprint is NOT guaranteed to pass
 * Cloudflare on every platform (it happens to on some macOS builds; many Linux
 * builds are rejected). See tools/README.md.
 *
 * WIRING: point the codex-oauth channel's `endpoint` at this sidecar, e.g.
 *   PATCH /admin/resources/<id>/channels/<channelId>
 *     { "endpoint": "http://127.0.0.1:8787/backend-api/codex" }
 * The adapter appends `/responses`; the sidecar forwards to
 * `${TARGET_ORIGIN}/backend-api/codex/responses` with a passing fingerprint.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? 8787);
const CURL_BIN = process.env.CODEX_CURL_BIN ?? 'curl';
const TARGET_ORIGIN = process.env.TARGET_ORIGIN ?? 'https://chatgpt.com';

// Hop-by-hop / length headers we must NOT forward verbatim (curl recomputes them).
const DROP = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'transfer-encoding',
]);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = `${TARGET_ORIGIN}${req.url}`;
    const args = ['-sS', '-i', '--no-buffer', '--max-time', '300', '-X', req.method ?? 'GET', url];
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP.has(k.toLowerCase())) continue;
      args.push('-H', `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`);
    }
    if (body.length > 0) args.push('--data-binary', '@-');

    const curl = spawn(CURL_BIN, args);
    if (body.length > 0) {
      curl.stdin.write(body);
      curl.stdin.end();
    }

    // curl -i streams: <status line>\r\n<headers>\r\n\r\n<body…>. Parse the head
    // block from the first chunks, then pipe the rest (incl. SSE) straight on.
    let headersSent = false;
    let buf = Buffer.alloc(0);
    curl.stdout.on('data', (d) => {
      if (headersSent) {
        res.write(d);
        return;
      }
      buf = Buffer.concat([buf, d]);
      // curl -i through an HTTPS CONNECT proxy prefixes the real response with a
      // "HTTP/1.1 200 Connection established\r\n\r\n" preamble. Skip any such
      // tunnel block(s) so we parse the REAL response head, not the proxy's.
      let start = 0;
      let sep;
      for (;;) {
        sep = buf.indexOf('\r\n\r\n', start);
        if (sep === -1) return; // header block not fully arrived yet
        const firstLine = buf.subarray(start, sep).toString('utf8').split('\r\n')[0] ?? '';
        if (/connection established/i.test(firstLine)) {
          start = sep + 4;
          continue;
        }
        break;
      }
      const head = buf.subarray(start, sep).toString('utf8');
      const rest = buf.subarray(sep + 4);
      const lines = head.split('\r\n');
      const statusLine = lines[0] ?? ''; // "HTTP/2 200" | "HTTP/1.1 400 Bad Request"
      const m = statusLine.match(/\s(\d{3})\b/);
      const status = m ? Number(m[1]) : 502;
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (DROP.has(name.toLowerCase())) continue;
        try {
          res.setHeader(name, value);
        } catch {
          /* skip an illegal header name/value */
        }
      }
      res.writeHead(status);
      headersSent = true;
      if (rest.length > 0) res.write(rest);
    });
    curl.stdout.on('end', () => {
      if (!headersSent) {
        res.writeHead(502);
        res.end(buf);
      } else {
        res.end();
      }
    });

    let errbuf = '';
    curl.stderr.on('data', (d) => (errbuf += d.toString()));
    curl.on('error', (e) => {
      if (!headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ proxy_error: e.message }));
      } else {
        res.end();
      }
    });
    curl.on('close', (code) => {
      if (code !== 0 && !headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ proxy_error: `${CURL_BIN} exit ${code}`, stderr: errbuf.slice(0, 300) }));
      }
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`codex-tls-proxy: 127.0.0.1:${PORT} -> ${TARGET_ORIGIN} (via ${CURL_BIN})`);
});
