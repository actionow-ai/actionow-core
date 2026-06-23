import { z } from 'zod';

/**
 * Create a managed egress {@link proxy} (代理). The `url` is the full proxy URL
 * (e.g. `http://user:pass@host:port`, `socks5://host:port`) — write-only,
 * encrypted at rest; the view never returns it (only `scheme`/`host`).
 */
export const createProxySchema = z.object({
  name: z.string().min(1),
  /** Full proxy URL incl. any credentials. http/https/socks5/socks5h. */
  url: z.string().min(1),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().optional(),
});
export type CreateProxyBody = z.infer<typeof createProxySchema>;

/** Patch a proxy (all optional). Supplying `url` re-encrypts + re-derives scheme/host. */
export const updateProxySchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().nullable().optional(),
});
export type UpdateProxyBody = z.infer<typeof updateProxySchema>;

/**
 * Probe a proxy's reachability. Makes a GET through the proxy to `probeUrl`
 * (default a neutral 204 endpoint); ANY HTTP response = reachable, a transport
 * error = failing. Records health/latency and returns the updated view.
 */
export const proxyProbeRequestSchema = z.object({
  /** URL to fetch through the proxy; defaults to a neutral reachability endpoint. */
  probeUrl: z.string().url().optional(),
  /** Probe timeout in ms (default 10s). */
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});
export type ProxyProbeBody = z.infer<typeof proxyProbeRequestSchema>;

/** JSON view of a proxy — NEVER the full URL/credentials, only `scheme` + `host` + health. */
export const proxyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  scheme: z.string(),
  /** `host:port` (no credentials). */
  host: z.string(),
  status: z.string(),
  /** Last probe verdict: null = never probed. */
  healthy: z.boolean().nullable(),
  last_checked_at: z.string().nullable(),
  last_latency_ms: z.number().nullable(),
  last_error: z.string().nullable(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProxyView = z.infer<typeof proxyViewSchema>;
