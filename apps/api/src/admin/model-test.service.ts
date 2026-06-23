import { AdapterError, type AdapterRegistry, type ProviderAdapter } from '@actionow/adapters';
import type {
  AdapterContext,
  ChatRequest,
  HttpClient,
  MediaResult,
  Message,
  ModelTestCheck,
  ModelTestRequest,
  ModelTestResult,
  PluginManifest,
  SubmitInput,
  UnifiedError,
} from '@actionow/contracts';
import {
  type Database,
  getPluginVersion,
  getResource,
  listChannels,
  type UpstreamChannelRow,
} from '@actionow/db';
import { PLUGIN_PROVIDER_TYPE } from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, HTTP } from '../common/tokens.js';

/** Wall-clock budget for the async media poll loop (image/video/audio). */
const MEDIA_POLL_INTERVAL_MS = 2500;
const MEDIA_POLL_MAX_ATTEMPTS = 48; // 48 × 2.5s = 120s ceiling
/** Bound the chat probe's output so a chatty model can't run up cost on a ping. */
const CHAT_PROBE_MAX_TOKENS = 32;

/**
 * Probes a CANDIDATE model (before its `model` row exists) against a resource's
 * upstream channel and reports two independent legs:
 *
 * - **connectivity** — did we REACH the upstream and AUTHENTICATE? A raw egress
 *   failure, an `unauthorized`, or an `upstream_timeout` fails this leg.
 * - **functional** — did the model PRODUCE valid output? (a non-empty chat
 *   completion / a generated asset). A reached-but-erroring upstream passes
 *   connectivity and fails functional.
 *
 * It builds the {@link AdapterContext} the SAME way the engine does (per-channel
 * credential/endpoint/config/proxy, plugin snapshot + credentials for
 * plugin-served channels) so the probe exercises the real dispatch path. No
 * `model`/`job`/`usage_log` row is written — this is a pure read-only dry run.
 */
@Injectable()
export class ModelTestService {
  private readonly http: HttpClient;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    private readonly secrets: SecretResolver,
    @Inject(ENV) private readonly env: AppEnv,
    @Optional() @Inject(HTTP) http?: HttpClient,
  ) {
    this.http = http ?? createHttpClient();
  }

  async test(dto: ModelTestRequest): Promise<ModelTestResult> {
    const startedAt = Date.now();
    const resource = await getResource(this.db, dto.resourceId);
    if (resource === undefined) {
      throw engineNotFound(`resource ${dto.resourceId} not found`);
    }
    // Resource has few channels; the listChannels page already filters to active.
    const channels = await listChannels(this.db, dto.resourceId);
    const channel =
      dto.channelId !== undefined ? channels.find((c) => c.id === dto.channelId) : channels[0];
    if (channel === undefined) {
      throw engineInvalidInput(
        dto.channelId !== undefined
          ? `channel ${dto.channelId} not found (or inactive) for resource ${dto.resourceId}`
          : `resource ${dto.resourceId} has no active channel to test against`,
      );
    }

    const { ctx, providerType } = await this.buildContext(channel);
    const adapter = this.adapters.get(providerType);

    const result =
      resource.modality === 'text' || resource.modality === 'chat'
        ? await this.probeChat(adapter, ctx, dto.model)
        : await this.probeMedia(adapter, ctx, dto.resourceId, resource.modality);

    return {
      modality: resource.modality,
      channelId: channel.id,
      providerType,
      elapsedMs: Date.now() - startedAt,
      ...result,
    };
  }

  // ----- probes -----

  /**
   * Chat leg: send a one-line ping and require a non-empty completion. Prefers
   * the blocking `chat`; falls back to aggregating `streamChat` for stream-only
   * adapters (e.g. codex-oauth). A provider with neither fails BOTH legs with a
   * clear message (it cannot serve a chat model at all).
   */
  private async probeChat(
    adapter: ProviderAdapter,
    ctx: AdapterContext,
    candidateModel: string,
  ): Promise<Pick<ModelTestResult, 'connectivity' | 'functional' | 'sample'>> {
    if (adapter.chat === undefined && adapter.streamChat === undefined) {
      const message = `provider ${ctx.providerType} does not support chat`;
      return { connectivity: fail(message), functional: fail(message) };
    }
    const ir: ChatRequest = {
      model: ctx.model ?? candidateModel,
      messages: [
        { role: 'user', content: [{ kind: 'text', text: 'Reply with the single word: ok' }] },
      ],
      params: { temperature: 0, maxOutputTokens: CHAT_PROBE_MAX_TOKENS },
    };
    try {
      const text =
        adapter.chat !== undefined
          ? messageText((await adapter.chat(ir, ctx)).message)
          : await aggregateStream(adapter, ir, ctx);
      const ok = text.trim().length > 0;
      return {
        connectivity: pass('reached upstream and authenticated'),
        functional: ok
          ? pass('received a non-empty completion')
          : fail('upstream returned an empty completion'),
        ...(text.trim().length > 0 ? { sample: { text: text.slice(0, 200) } } : {}),
      };
    } catch (err) {
      return this.classify(err);
    }
  }

  /**
   * Media leg (image/video/audio): submit a minimal generation, then (for an
   * async handle) poll to completion within {@link MEDIA_POLL_MAX_ATTEMPTS}.
   * Submit acceptance proves connectivity; a produced asset proves function.
   */
  private async probeMedia(
    adapter: ProviderAdapter,
    ctx: AdapterContext,
    resourceId: string,
    modality: string,
  ): Promise<Pick<ModelTestResult, 'connectivity' | 'functional' | 'sample'>> {
    const input: SubmitInput = {
      resourceId,
      modality,
      inputs: minimalMediaInputs(modality),
      execMode: 'async-poll',
      ctx,
    };
    try {
      const submitted = await adapter.submit(input);
      if (submitted.kind === 'sync') {
        const url = assetUrl(submitted.mediaResult, submitted.output);
        return mediaVerdict(url);
      }
      // async handle → poll
      if (adapter.poll === undefined) {
        return {
          connectivity: pass('submit accepted by upstream'),
          functional: fail(`provider ${ctx.providerType} returned an async job but cannot poll it`),
        };
      }
      for (let attempt = 0; attempt < MEDIA_POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(MEDIA_POLL_INTERVAL_MS);
        const polled = await adapter.poll(submitted.upstreamJobId, ctx);
        if (polled.status === 'succeeded') {
          return mediaVerdict(assetUrl(polled.mediaResult, polled.output));
        }
        if (polled.status === 'failed') {
          const message = polled.error?.message ?? 'upstream job failed';
          return {
            connectivity: pass('submit accepted by upstream'),
            functional: fail(message, polled.error?.code),
          };
        }
      }
      const timeoutSec = (MEDIA_POLL_INTERVAL_MS * MEDIA_POLL_MAX_ATTEMPTS) / 1000;
      return {
        connectivity: pass('submit accepted by upstream'),
        functional: fail(`job did not complete within ${String(timeoutSec)}s`, 'upstream_timeout'),
      };
    } catch (err) {
      return this.classify(err);
    }
  }

  // ----- context + classification -----

  /**
   * Build the {@link AdapterContext} for the probe — mirrors the engine's
   * `buildContext`: per-channel `model`/`endpoint`/`config`, the credential +
   * egress proxy resolved via {@link SecretResolver}, and (for a plugin-bound
   * channel) the frozen plugin snapshot + the resolved credential map. Returns
   * the `providerType` to dispatch on (`'plugin'` for plugin channels).
   */
  private async buildContext(
    channel: UpstreamChannelRow,
  ): Promise<{ ctx: AdapterContext; providerType: string }> {
    // Capture the binding once so TS narrows away the `null`s without `!`.
    const pluginId = channel.pluginId;
    const pluginVersion = channel.pluginVersion;
    const isPlugin = pluginId !== null && pluginVersion !== null;
    const providerType = isPlugin ? PLUGIN_PROVIDER_TYPE : channel.providerType;
    const ctx: AdapterContext = { providerType, http: this.http };
    if (channel.model !== null) ctx.model = channel.model;
    if (channel.endpoint !== null) ctx.endpoint = channel.endpoint;
    if (channel.config !== null) ctx.config = channel.config;
    const proxyUrl = await this.resolveProxy(channel);
    if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;

    if (pluginId !== null && pluginVersion !== null) {
      const snapshot = await getPluginVersion(this.db, pluginId, pluginVersion);
      if (snapshot === undefined) {
        throw engineInvalidInput(
          `plugin version ${String(pluginVersion)} not found for channel ${channel.id}`,
        );
      }
      ctx.plugin = { manifest: snapshot.manifest as PluginManifest, handler: snapshot.handler };
      ctx.credentials = await this.resolvePluginCredentials(channel);
    } else if (channel.credentialRef !== null) {
      const apiKey = await this.secrets.resolve(channel.credentialRef);
      if (apiKey !== undefined) ctx.apiKey = apiKey;
    }
    return { ctx, providerType };
  }

  /** Plugin credential map: non-secret `config` strings overlaid with the secret(s). */
  private async resolvePluginCredentials(
    channel: UpstreamChannelRow,
  ): Promise<Record<string, string>> {
    const cred: Record<string, string> = {};
    if (channel.config !== null) {
      for (const [k, v] of Object.entries(channel.config)) if (typeof v === 'string') cred[k] = v;
    }
    if (channel.credentialRef !== null) {
      const secret = await this.secrets.resolve(channel.credentialRef);
      if (secret !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(secret);
        } catch {
          parsed = undefined;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string') cred[k] = v;
          }
        } else {
          cred.api_key = secret;
        }
      }
    }
    return cred;
  }

  private async resolveProxy(channel: UpstreamChannelRow): Promise<string | undefined> {
    if (channel.proxyRef !== null) {
      const url = await this.secrets.resolve(channel.proxyRef);
      if (url !== undefined) return url;
    }
    return this.env.UPSTREAM_PROXY_URL;
  }

  /**
   * Map a thrown probe error to the two legs. A raw throw (egress failure) or an
   * `unauthorized`/`upstream_timeout` fails connectivity; any other structured
   * upstream error means we REACHED + authenticated, so connectivity passes and
   * only function fails.
   */
  private classify(err: unknown): Pick<ModelTestResult, 'connectivity' | 'functional'> {
    const unified = toUnified(err);
    const transport = !(err instanceof AdapterError);
    const reached =
      !transport && unified.code !== 'unauthorized' && unified.code !== 'upstream_timeout';
    if (!reached) {
      const message = transport ? `could not reach upstream: ${unified.message}` : unified.message;
      return { connectivity: fail(message, unified.code), functional: fail(message, unified.code) };
    }
    return {
      connectivity: pass('reached upstream and authenticated'),
      functional: fail(unified.message, unified.code),
    };
  }
}

// ----- pure helpers -----

function pass(message: string): ModelTestCheck {
  return { ok: true, message };
}
function fail(message: string, code?: string): ModelTestCheck {
  return code !== undefined ? { ok: false, message, code } : { ok: false, message };
}

function mediaVerdict(
  url: string | undefined,
): Pick<ModelTestResult, 'connectivity' | 'functional' | 'sample'> {
  return {
    connectivity: pass('submit accepted by upstream'),
    functional:
      url !== undefined
        ? pass('upstream produced an asset')
        : fail('upstream job succeeded but returned no asset'),
    ...(url !== undefined ? { sample: { url } } : {}),
  };
}

/** Concatenate the text parts of a chat message. */
function messageText(message: Message): string {
  return message.content
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** Aggregate a stream-only adapter's `content_delta`s into a single string. */
async function aggregateStream(
  adapter: ProviderAdapter,
  ir: ChatRequest,
  ctx: AdapterContext,
): Promise<string> {
  if (adapter.streamChat === undefined) return '';
  let text = '';
  for await (const ev of adapter.streamChat(ir, ctx)) {
    if (ev.type === 'content_delta') text += ev.text;
    if (ev.type === 'error') throw new AdapterError(ev.error);
  }
  return text;
}

/** First asset URL from a {@link MediaResult}, falling back to a `url` in raw output. */
function assetUrl(
  mediaResult: MediaResult | undefined,
  output: Record<string, unknown> | undefined,
): string | undefined {
  const fromResult = mediaResult?.assets.find((a) => a.url !== undefined)?.url;
  if (fromResult !== undefined) return fromResult;
  const raw = output?.url;
  return typeof raw === 'string' ? raw : undefined;
}

/** Minimal generation inputs per modality — just enough to exercise the model. */
function minimalMediaInputs(modality: string): Record<string, unknown> {
  if (modality === 'video') return { prompt: 'a small red circle on white', duration: 1 };
  if (modality === 'audio') return { prompt: 'connectivity test' };
  return { prompt: 'a small red circle on white' };
}

function toUnified(err: unknown): UnifiedError {
  if (err instanceof AdapterError) return err.unified;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return err as UnifiedError;
  }
  return {
    code: 'upstream_error',
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
