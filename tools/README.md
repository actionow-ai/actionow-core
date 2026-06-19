# tools/codex-tls-proxy

A loopback TLS-egress sidecar for the **codex-oauth** relay channel.

## Why it exists

The private Codex backend (`https://chatgpt.com/backend-api/codex`) sits behind
Cloudflare, which fingerprints the TLS ClientHello (JA3/JA4). **Node's built-in
HTTP client (undici) presents a fingerprint Cloudflare rejects** — the connection
is reset before any HTTP response arrives (`ECONNRESET`), even for the public
page. A client with a browser-like fingerprint passes.

We deliberately do **not** embed TLS-fingerprint spoofing in the application
code. Instead the relay keeps its normal Node HTTP client and routes the one
Cloudflare-fronted upstream through this sidecar:

```
Actionow relay (Node)  --plain HTTP-->  127.0.0.1:8787  --curl (passing JA3)-->  chatgpt.com
```

The sidecar is intentionally tiny, **bound to loopback only**, and **scoped to a
single origin** (it is not an open forward proxy). It is for an operator relaying
**their own paid ChatGPT/Codex subscription** (opt-in, BYO-account,
ToS-acknowledged — see `ENABLE_OAUTH_CHANNELS`).

## Run it

```bash
# dev (macOS): the system curl fingerprint often passes
node tools/codex-tls-proxy.mjs

# production (Linux): use a browser-fingerprint curl — see below
CODEX_CURL_BIN=curl_chrome124 node tools/codex-tls-proxy.mjs
```

Env:

| var              | default               | meaning                            |
| ---------------- | --------------------- | ---------------------------------- |
| `PORT`           | `8787`                | loopback port                      |
| `CODEX_CURL_BIN` | `curl`                | curl binary to egress through      |
| `TARGET_ORIGIN`  | `https://chatgpt.com` | the single allowed upstream origin |

> ⚠️ **The OS `curl` fingerprint is not guaranteed to pass Cloudflare on every
> platform.** It happens to on some macOS builds; many Linux `curl` builds are
> rejected. For any real deployment, point `CODEX_CURL_BIN` at a
> **curl-impersonate** binary.

## Installing curl-impersonate (production)

[curl-impersonate](https://github.com/lwthiker/curl-impersonate) ships `curl`
builds + drop-in wrapper scripts (`curl_chrome124`, `curl_ff117`, …) that present
a real browser's TLS + HTTP/2 fingerprint. The wrappers are argument-compatible
with this sidecar (it only adds `-H`, `-i`, `--no-buffer`, `-X`, `--data-binary`).

- **Docker:** `docker run --network host -e CODEX_CURL_BIN=curl_chrome124 …` against
  an image that bundles curl-impersonate, or run curl-impersonate in its own
  container and shell to it.
- **Linux binaries:** download a release, put the `curl-impersonate-chrome`
  wrapper (`curl_chrome124`) on `PATH`, then `CODEX_CURL_BIN=curl_chrome124`.

Verify a binary passes before wiring it in:

```bash
$CODEX_CURL_BIN -sS -o /dev/null -w '%{http_code}\n' https://chatgpt.com/
# a 2xx/3xx/403 (any HTTP response) = the fingerprint passed;
# a connection reset / curl exit 35/56 = still blocked, try another profile
```

## Wire the channel to it

Point the codex-oauth channel's `endpoint` at the sidecar (the adapter appends
`/responses`):

```bash
curl -X PATCH http://localhost:3000/admin/resources/<resourceId>/channels/<channelId> \
  -H "authorization: Bearer <admin-jwt>" -H 'content-type: application/json' \
  -d '{"endpoint":"http://127.0.0.1:8787/backend-api/codex"}'
```

## Notes / limits

- **Single origin, loopback-only** — not a general proxy. Run one instance per
  Cloudflare-fronted upstream if you add more (e.g. a future claude-oauth) via
  `TARGET_ORIGIN` + `PORT`.
- Streams Server-Sent Events through unbuffered (`--no-buffer`), so the relay's
  streaming chat path works end to end.
- It forwards the request's `Authorization` + Codex impersonation headers as-is;
  it adds nothing of its own beyond the curl binary's TLS/HTTP fingerprint.
