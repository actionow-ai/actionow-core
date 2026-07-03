import type { HttpClient, HttpResponse, MediaResult, PluginManifest } from '@actionow/contracts';
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

/** What a handler's `mapRequest` / `mapPollRequest` returns. */
interface RequestSpec {
  method?: string;
  pathSuffix?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function sandboxOpts(deps: PluginRunDeps): { timeoutMs?: number } {
  return deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {};
}

/**
 * Build the upstream request from a handler request-spec, apply the named signer
 * OUTSIDE the sandbox (the only place credentials appear), and dispatch via http.
 * Throws {@link EngineError} on a bad spec or a non-2xx response.
 */
async function executeRequest(
  plugin: PluginSnapshot,
  spec: RequestSpec,
  deps: PluginRunDeps,
  defaultMethod: 'GET' | 'POST',
): Promise<HttpResponse> {
  const m = spec.method?.toUpperCase();
  const method: 'GET' | 'POST' = m === 'GET' ? 'GET' : m === 'POST' ? 'POST' : defaultMethod;

  // SECURITY: the sandbox handler controls `pathSuffix`, which is concatenated
  // onto the channel endpoint. A hostile suffix like `@evil.com/x` or
  // `.evil.com/x` rewrites the URL host, which would send the request — carrying
  // the resolved credentials applied by `applySigner` below — to an attacker.
  // Pin the built URL's origin to the channel endpoint's origin: credentials may
  // only ever reach the configured upstream host.
  const url = new URL(`${deps.endpoint}${spec.pathSuffix ?? ''}`);
  const endpointOrigin = new URL(deps.endpoint).origin;
  if (url.origin !== endpointOrigin) {
    throw new EngineError({
      code: 'internal_error',
      message: `plugin request-spec pathSuffix must not change the upstream origin (channel ${endpointOrigin}, got ${url.origin})`,
      retryable: false,
    });
  }
  if (spec.query !== undefined) {
    for (const [k, v] of Object.entries(spec.query)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...spec.headers };

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
  return res;
}

/** Run a handler fn that must return an object; throws a typed error otherwise. */
async function runObjectHandler(
  plugin: PluginSnapshot,
  fnName: 'mapRequest' | 'mapPollRequest',
  arg: unknown,
  deps: PluginRunDeps,
): Promise<RequestSpec> {
  const raw = await runHandler(plugin.handler, fnName, arg, sandboxOpts(deps));
  if (!isRecord(raw)) {
    throw new EngineError({
      code: 'internal_error',
      message: `plugin ${fnName} did not return an object`,
      retryable: false,
    });
  }
  return raw;
}

function parseMediaResult(raw: unknown, where: string): MediaResult {
  const parsed = mediaResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError({
      code: 'internal_error',
      message: `plugin ${where} did not return a valid MediaResult: ${parsed.error.message}`,
      retryable: false,
    });
  }
  return parsed.data;
}

/**
 * Run a SYNC-protocol provider plugin end-to-end (spec §3.3): `mapRequest`
 * [sandbox] → signer [OUTSIDE sandbox] → http → `mapResponse` [sandbox] →
 * validated {@link MediaResult}. Handler convention: `mapRequest(ctx)` and
 * `mapResponse({ response, ctx })`.
 */
export async function runPluginSync(
  plugin: PluginSnapshot,
  hctx: PluginHandlerCtx,
  deps: PluginRunDeps,
): Promise<MediaResult> {
  const spec = await runObjectHandler(plugin, 'mapRequest', hctx, deps);
  const res = await executeRequest(plugin, spec, deps, 'POST');
  const mrRaw = await runHandler(
    plugin.handler,
    'mapResponse',
    { response: res.body, ctx: hctx },
    sandboxOpts(deps),
  );
  return parseMediaResult(mrRaw, 'mapResponse');
}

export interface PluginSubmitOutcome {
  upstreamJobId: string;
}

/**
 * Submit an ASYNC-POLL plugin job: `mapRequest` [sandbox] → signer → http →
 * `mapSubmit({ response, ctx })` [sandbox] → `{ upstreamJobId }`. The worker then
 * polls via {@link runPluginPoll}.
 */
export async function runPluginSubmit(
  plugin: PluginSnapshot,
  hctx: PluginHandlerCtx,
  deps: PluginRunDeps,
): Promise<PluginSubmitOutcome> {
  const spec = await runObjectHandler(plugin, 'mapRequest', hctx, deps);
  const res = await executeRequest(plugin, spec, deps, 'POST');
  const subRaw = await runHandler(
    plugin.handler,
    'mapSubmit',
    { response: res.body, ctx: hctx },
    sandboxOpts(deps),
  );
  const rawId = isRecord(subRaw) ? subRaw.upstreamJobId : undefined;
  const upstreamJobId =
    typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';
  if (upstreamJobId === '') {
    throw new EngineError({
      code: 'upstream_error',
      message: 'plugin mapSubmit did not return an upstreamJobId',
      retryable: false,
    });
  }
  return { upstreamJobId };
}

export interface PluginPollOutcome {
  state: 'running' | 'succeeded' | 'failed';
  mediaResult?: MediaResult;
  error?: string;
}

/**
 * Poll an ASYNC-POLL plugin job: `mapPollRequest({ upstreamJobId, ctx })`
 * [sandbox] → signer → http → `mapPoll({ response, ctx })` [sandbox] →
 * `{ state, result? }`. On `succeeded` the `result` is validated as a
 * {@link MediaResult}. `mapPoll` is the AUTHORITATIVE status mapping (spec §4.6).
 */
export async function runPluginPoll(
  plugin: PluginSnapshot,
  upstreamJobId: string,
  hctx: PluginHandlerCtx,
  deps: PluginRunDeps,
): Promise<PluginPollOutcome> {
  const spec = await runObjectHandler(plugin, 'mapPollRequest', { upstreamJobId, ctx: hctx }, deps);
  const res = await executeRequest(plugin, spec, deps, 'GET');
  const polled = await runHandler(
    plugin.handler,
    'mapPoll',
    { response: res.body, ctx: hctx },
    sandboxOpts(deps),
  );
  if (!isRecord(polled)) {
    throw new EngineError({
      code: 'internal_error',
      message: 'plugin mapPoll did not return an object',
      retryable: false,
    });
  }
  const state = polled.state;
  if (state === 'succeeded') {
    return { state: 'succeeded', mediaResult: parseMediaResult(polled.result, 'mapPoll') };
  }
  if (state === 'failed') {
    return {
      state: 'failed',
      error: typeof polled.error === 'string' ? polled.error : 'plugin job failed',
    };
  }
  return { state: 'running' };
}
