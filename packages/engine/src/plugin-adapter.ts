import type { AdapterRegistry, ProviderAdapter } from '@actionow/adapters';
import type {
  AdapterContext,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { EngineError } from './errors.js';
import {
  type PluginHandlerCtx,
  type PluginRunDeps,
  type PluginSnapshot,
  runPluginPoll,
  runPluginSubmit,
  runPluginSync,
} from './plugin-runner.js';

/** The providerType the generic plugin adapter registers under. */
export const PLUGIN_PROVIDER_TYPE = 'plugin';

function requirePlugin(ctx: AdapterContext): PluginSnapshot {
  if (ctx.plugin === undefined) {
    throw new EngineError({
      code: 'internal_error',
      message: 'plugin channel is missing its plugin snapshot',
      retryable: false,
    });
  }
  return ctx.plugin;
}

function depsFrom(ctx: AdapterContext): PluginRunDeps {
  return {
    http: ctx.http,
    endpoint: ctx.endpoint ?? '',
    credentials: ctx.credentials ?? {},
    nowMs: Date.now(),
    ...(ctx.proxyUrl !== undefined ? { proxyUrl: ctx.proxyUrl } : {}),
  };
}

function handlerCtx(ctx: AdapterContext, inputs: Record<string, unknown>): PluginHandlerCtx {
  return {
    inputs,
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
    ...(ctx.config !== undefined ? { config: ctx.config } : {}),
  };
}

/**
 * The generic provider-plugin adapter (spec §3.3): one code path that interprets
 * ANY `provider_plugin` via the QuickJS sandbox + named signer registry, replacing
 * "one code adapter per provider". Registered under `providerType='plugin'`; the
 * channel loader sets `ctx.plugin` (frozen snapshot) + `ctx.credentials` (resolved
 * secrets, used only by the signer outside the sandbox). Sync protocol settles
 * inline; async-poll submits + polls through the worker JobRunner (whose settle is
 * MediaResult-aware).
 */
export function createPluginAdapter(): ProviderAdapter {
  return {
    providerType: PLUGIN_PROVIDER_TYPE,

    async submit(input: SubmitInput): Promise<SubmitResult> {
      const { ctx, inputs, modality } = input;
      const plugin = requirePlugin(ctx);
      const hctx = handlerCtx(ctx, inputs);
      const deps = depsFrom(ctx);
      if (plugin.manifest.protocol === 'sync') {
        const mr = await runPluginSync(plugin, hctx, deps);
        return {
          kind: 'sync',
          output: mr as unknown as Record<string, unknown>,
          usage: mr.usage,
          mediaResult: mr,
        };
      }
      const sub = await runPluginSubmit(plugin, hctx, deps);
      return {
        kind: 'async',
        provider: PLUGIN_PROVIDER_TYPE,
        upstreamJobId: sub.upstreamJobId,
        meta: { modality },
      };
    },

    async poll(upstreamJobId: string, ctx: AdapterContext): Promise<PollResult> {
      const plugin = requirePlugin(ctx);
      const r = await runPluginPoll(plugin, upstreamJobId, handlerCtx(ctx, {}), depsFrom(ctx));
      if (r.state === 'succeeded') {
        return {
          status: 'succeeded',
          usage: r.mediaResult?.usage ?? {},
          ...(r.mediaResult !== undefined ? { mediaResult: r.mediaResult } : {}),
        };
      }
      if (r.state === 'failed') {
        return {
          status: 'failed',
          error: { code: 'job_failed', message: r.error ?? 'plugin job failed', retryable: false },
        };
      }
      return { status: 'running' };
    },

    extractUsage(): UsageVector {
      return {};
    },

    mapError(): UnifiedError {
      return { code: 'upstream_error', message: 'plugin error', retryable: false };
    },
  };
}

/**
 * Register the engine-provided adapters (currently the generic plugin adapter)
 * into an existing registry. Called by the api + worker after
 * `createDefaultRegistry()` — the adapters package can't depend on the engine, so
 * the engine's adapters are wired in at the app layer.
 */
export function registerEngineAdapters(registry: AdapterRegistry): AdapterRegistry {
  registry.register(createPluginAdapter());
  return registry;
}
