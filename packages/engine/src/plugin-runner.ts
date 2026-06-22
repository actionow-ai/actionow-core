import type { HttpClient, MediaResult, PluginManifest } from '@actionow/contracts';
import { mediaResultSchema } from '@actionow/contracts';

import { EngineError } from './errors.js';
import { runHandler } from './sandbox.js';
import { applySigner, type SignerInput } from './signers.js';

/** A frozen plugin snapshot (manifest + handler) the runner executes. */
export interface PluginSnapshot {
  manifest: PluginManifest;
  handler: string;
}

/**
 * The NON-SECRET context passed into the sandbox handler (spec §3.2): the
 * validated inputs, resolved model/params, and the channel's non-secret config.
 * Credentials are DELIBERATELY absent — auth happens outside the sandbox (D7).
 */
export interface PluginHandlerCtx {
  inputs: Record<string, unknown>;
  model?: string | undefined;
  params?: Record<string, unknown> | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface PluginRunDeps {
  http: HttpClient;
  /** The channel base URL (e.g. https://api.openai.com). */
  endpoint: string;
  /** Resolved secrets (api_key / ak / sk …) — consumed ONLY by the signer, never the sandbox. */
  credentials: Record<string, string>;
  /** Injected clock (unix ms) for deterministic signing. */
  nowMs: number;
  proxyUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

/** What a handler's `mapRequest` returns. */
interface MapRequestSpec {
  method?: string;
  pathSuffix?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Run a SYNC-protocol provider plugin end-to-end (spec §3.3): `mapRequest`
 * [sandbox] → platform applies the named signer [OUTSIDE sandbox, keys injected]
 * → http → `mapResponse` [sandbox] → validated {@link MediaResult}. The handler
 * receives `mapRequest(ctx)` and `mapResponse({ response, ctx })` (single-arg
 * convention so the sandbox marshals one JSON value). Throws {@link EngineError}
 * on a bad handler shape, upstream non-2xx, or a result that fails the contract.
 */
export async function runPluginSync(
  plugin: PluginSnapshot,
  hctx: PluginHandlerCtx,
  deps: PluginRunDeps,
): Promise<MediaResult> {
  const specRaw = await runHandler(plugin.handler, 'mapRequest', hctx, {
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  if (!isRecord(specRaw)) {
    throw new EngineError({
      code: 'internal_error',
      message: 'plugin mapRequest did not return an object',
      retryable: false,
    });
  }
  const spec = specRaw as MapRequestSpec;
  const method: 'GET' | 'POST' = spec.method?.toUpperCase() === 'GET' ? 'GET' : 'POST';

  const url = new URL(`${deps.endpoint}${spec.pathSuffix ?? ''}`);
  if (spec.query !== undefined) {
    for (const [k, v] of Object.entries(spec.query)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...spec.headers };

  // Auth/signing OUTSIDE the sandbox — the only place credentials appear.
  const signerInput: SignerInput = {
    method,
    url: url.toString(),
    headers,
    body: JSON.stringify(spec.body ?? {}),
    credentials: deps.credentials,
    nowMs: deps.nowMs,
  };
  const signed = applySigner(plugin.manifest.authStrategy, signerInput);

  const res = await deps.http.request({
    method,
    url: signed.url,
    headers: signed.headers,
    body: spec.body,
    ...(deps.proxyUrl !== undefined ? { proxyUrl: deps.proxyUrl } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  if (!res.ok) {
    throw new EngineError({
      code: 'upstream_error',
      message: `plugin upstream returned ${String(res.status)}`,
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  const mrRaw = await runHandler(
    plugin.handler,
    'mapResponse',
    { response: res.body, ctx: hctx },
    { ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}) },
  );
  const parsed = mediaResultSchema.safeParse(mrRaw);
  if (!parsed.success) {
    throw new EngineError({
      code: 'internal_error',
      message: `plugin mapResponse did not return a valid MediaResult: ${parsed.error.message}`,
      retryable: false,
    });
  }
  return parsed.data;
}
