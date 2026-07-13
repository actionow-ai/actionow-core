// packages/engine/src/gateway/dialect-resolve.ts
//
// model-supply-greenfield 批次4 slice2 — offering → dialect resolution (§2.2/
// §2.3/§6 热更新一致性). The dialect ref is the channel's override when set,
// else the provider's default (官方 vs 中转分叉点), resolved against the
// versioned SPI registry by EXACT {ref, version} — an unregistered pin is an
// AUTHORING/DEPLOY defect surfaced as `internal_error`, never blamed on the
// caller or the upstream.
//
// The per-call DialectContext is assembled HERE (channel-scoped environment
// only — never request params, never offering declarations, §6): baseUrl =
// channel.base_url, config = the channel's protocol configuration (signing
// region + the provider's callback-verification template), nowMs = the
// injected clock sample.
import type { DialectRef, GatewayError } from '@actionow/contracts';
import type { Dialect, DialectContext, DialectRegistry } from '@actionow/spi';

/** What {@link resolveDialectForOffering} needs: the versioned SPI registry. */
export interface ResolveDialectDeps {
  registry: DialectRegistry;
}

/** The channel facts the resolution consumes (structurally satisfied by RoutingCandidateChannel). */
export interface ResolveDialectChannel {
  id: string;
  dialect: DialectRef | null;
  baseUrl: string | null;
  region: string | null;
}

/** The provider defaults (§2.2); absent provider is tolerated when the channel pins its own dialect. */
export interface ResolveDialectProvider {
  slug?: string | undefined;
  defaultDialect: DialectRef | null;
  callbackVerification?: Record<string, unknown> | null | undefined;
  region?: string | null | undefined;
}

export interface ResolveDialectInput {
  channel: ResolveDialectChannel;
  provider?: ResolveDialectProvider | undefined;
  /** Injected unix-ms clock sample (deterministic signing/JWT in tests). */
  nowMs: number;
}

export type ResolveDialectResult =
  | { ok: true; dialect: Dialect; ctx: DialectContext }
  | { ok: false; error: GatewayError };

function internalError(message: string): GatewayError {
  return { code: 'internal_error', message, retryable: false, failover: false };
}

/**
 * Resolve the SELECTED offering's dialect (§2.3: channel.dialect ??
 * provider.default_dialect) via {@link DialectRegistry.resolve} and assemble
 * its {@link DialectContext}. Failure modes (both config defects, both
 * `internal_error`): no ref anywhere (channel inherits but the provider
 * declares none / is missing), or the pinned {ref, version} is not registered
 * (方言未注册 — deploy drift between the registry build and the supply config).
 */
export function resolveDialectForOffering(
  deps: ResolveDialectDeps,
  input: ResolveDialectInput,
): ResolveDialectResult {
  const ref: DialectRef | null = input.channel.dialect ?? input.provider?.defaultDialect ?? null;
  if (ref === null) {
    return {
      ok: false,
      error: internalError(
        `channel ${input.channel.id} pins no dialect and its provider declares no default_dialect`,
      ),
    };
  }
  const dialect = deps.registry.resolve(ref);
  if (dialect === undefined) {
    return {
      ok: false,
      error: internalError(
        `dialect ${ref.ref}@${ref.version} (channel ${input.channel.id}) is not registered — 方言未注册`,
      ),
    };
  }

  const config: Record<string, unknown> = {};
  const region = input.channel.region ?? input.provider?.region ?? null;
  if (region !== null) config.region = region;
  const callbackVerification = input.provider?.callbackVerification ?? null;
  if (callbackVerification !== null) config.callback_verification = callbackVerification;

  const ctx: DialectContext = {
    ...(input.channel.baseUrl !== null ? { baseUrl: input.channel.baseUrl } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    nowMs: input.nowMs,
  };
  return { ok: true, dialect, ctx };
}
