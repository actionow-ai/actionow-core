// Cloudflare Pages advanced-mode Worker for the Actionow console SPA.
//
// Serves the static SPA and reverse-proxies the API paths to the Zeabur API
// gateway — a 1:1 port of docker/nginx.zeabur.conf. The browser therefore stays
// SAME-ORIGIN (e.g. core.actionow.ai), so no CORS and no frontend rebuild are
// needed. Vite copies files under apps/web/public/ to the build output root, so
// this ships as `dist/_worker.js` and Cloudflare Pages runs it in advanced mode.
//
// The upstream API origin defaults to the SG deploy; override per-environment via
// the Pages env var `API_ORIGIN`.
const DEFAULT_API_ORIGIN = 'https://actionow-core-sg-api.zeabur.app';

// API-only prefixes (no web route lives here) → always the API.
const API_ONLY = /^\/(v1|v1beta|admin|auth|healthz?|readyz?)(\/|$)/;
// /console is shared: browser navigation (Accept: text/html) → SPA; XHR → API.
const CONSOLE = /^\/console(\/|$)/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
    const apiOrigin = (env && env.API_ORIGIN) || DEFAULT_API_ORIGIN;

    // OAuth hand-off: the API 302s to /auth/callback#token=… (top-level nav) → SPA.
    if (path === '/auth/callback') return serveSpa(request, url, env);

    if (API_ONLY.test(path)) return proxyApi(request, url, apiOrigin);
    if (CONSOLE.test(path)) {
      return wantsHtml ? serveSpa(request, url, env) : proxyApi(request, url, apiOrigin);
    }

    // Everything else (/, /login, /app/*, assets) → the SPA.
    return serveSpa(request, url, env);
  },
};

function proxyApi(request, url, apiOrigin) {
  const target = new URL(url.pathname + url.search, apiOrigin).toString();
  const req = new Request(target, request);
  // Preserve the public host so the API builds correct absolute URLs / redirects.
  req.headers.set('X-Forwarded-Host', url.host);
  req.headers.set('X-Forwarded-Proto', 'https');
  // Return the upstream response (incl. 3xx) to the browser rather than following.
  return fetch(req, { redirect: 'manual' });
}

async function serveSpa(request, url, env) {
  const res = await env.ASSETS.fetch(request);
  // SPA fallback: an unknown client-side route → index.html.
  if (res.status === 404) {
    return env.ASSETS.fetch(new Request(new URL('/index.html', url).toString(), request));
  }
  return res;
}
