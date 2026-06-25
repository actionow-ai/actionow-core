import type { Request } from 'express';

/** The per-request canary header that pins a relay call to tag-carrying channels. */
const HEADER = 'x-actionow-route-tag';

/**
 * 染色/标签路由: the trimmed non-empty `X-Actionow-Route-Tag` header value, or
 * `undefined`. A blank/absent header is a no-op (header-less relay requests stay
 * byte-for-byte unchanged), so callers thread the result straight into
 * `candidatesFor(...)` / `RunRequest.routeTag` where `undefined` skips filtering.
 */
export function routeTagHeader(req: Request): string | undefined {
  const raw = req.headers[HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
