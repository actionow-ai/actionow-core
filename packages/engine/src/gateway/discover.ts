// packages/engine/src/gateway/discover.ts
//
// model-supply-greenfield 批次5 slice2 — DISCOVER MODELS on a channel (§10
// 发现与批建, Major A5): the first step of the onboarding wizard. Two sources,
// picked by what the channel's dialect can offer (方言 discovery 端点或目录勾选
// 二选一):
//
//   - `dialect_discovery` — the dialect's DSL pack declares a `discovery`
//     endpoint (batch-2 pure core: `buildDiscoveryRequest` /
//     `parseDiscoveredModels`). This module adds the HTTP leg: resolve the
//     dialect + ctx exactly like the gateway (`resolveDialectForOffering`),
//     take the channel's credential-pool head, inject the credential through
//     the dialect's OWN aspect ③ (a discovery endpoint is authenticated like
//     any other call), fetch, parse.
//   - `catalog` — code-aspect dialects (and packs without a discovery
//     declaration) list candidates from the official catalog (`model_spec`
//     rows by the provider's slug).
//
// Either way each candidate is flagged `existsAsOffering` (the channel already
// carries a live offering with that upstream name) so the wizard UI/API caller
// can pre-filter picks. THIN like the golden probe: db READS only (offerings,
// credential pool + vault, model_spec), one optional HTTP GET, no writes.
import type { HttpClient, HttpRequest, ProviderModel } from '@actionow/contracts';
import type { DbOrTx } from '@actionow/db';
import {
  listActiveCredentialsForChannel,
  listModelSpecs,
  listSupplyOfferings,
  resolveSupplyCredentialSecret,
} from '@actionow/db';
import type { DialectPack, DialectRegistry } from '@actionow/spi';
import { buildDiscoveryRequest, composeWireUrl, parseDiscoveredModels } from '@actionow/spi';

import type { ResolveDialectProvider } from './dialect-resolve.js';
import { resolveDialectForOffering } from './dialect-resolve.js';
import type { GoldenProbeChannel } from './golden-probe.js';

// --- deps & subject ---------------------------------------------------------------

/** The db reads discovery performs (injectable — tests run on fakes + POISONED_DB). */
export interface DiscoverModelsQueries {
  listActiveCredentialsForChannel: typeof listActiveCredentialsForChannel;
  resolveSupplyCredentialSecret: typeof resolveSupplyCredentialSecret;
  listModelSpecs: typeof listModelSpecs;
  listSupplyOfferings: typeof listSupplyOfferings;
}

export interface DiscoverModelsDeps {
  db: DbOrTx;
  /** The versioned SPI registry (§6) — the SAME one the gateway/probe serve from. */
  registry: DialectRegistry;
  http: HttpClient;
  /**
   * DSL packs keyed `ref@version` ({@link packKeyOf}) — the `discovery`
   * declaration lives on the PACK, which the compiled Dialect drops. Absent /
   * unmatched → the catalog path.
   */
  packs?: ReadonlyMap<string, DialectPack> | undefined;
  nowMs?: (() => number) | undefined;
  /** Resolve channel.proxy_ref → egress proxy URL; absent → direct egress. */
  resolveProxyUrl?: ((proxyRef: string) => Promise<string | undefined>) | undefined;
  queries?: Partial<DiscoverModelsQueries> | undefined;
}

export interface DiscoverModelsSubject {
  channel: GoldenProbeChannel;
  provider?: ResolveDialectProvider | undefined;
}

// --- result ------------------------------------------------------------------------

export type DiscoveredModelSource = 'dialect_discovery' | 'catalog';

export interface DiscoveredModel {
  upstreamModelName: string;
  displayName?: string | undefined;
  source: DiscoveredModelSource;
  /** True when the channel already carries a LIVE offering with this upstream name. */
  existsAsOffering: boolean;
}

export type DiscoverModelsErrorCode =
  | 'no_credential'
  | 'secret_unresolvable'
  | 'dialect_unresolved'
  | 'discovery_http_error'
  | 'no_catalog_vendor';

export type DiscoverModelsOutcome =
  | { ok: true; source: DiscoveredModelSource; models: DiscoveredModel[] }
  | { ok: false; error: { code: DiscoverModelsErrorCode; message: string } };

/** The registry/pack addressing key: exact `ref@version` (§6 热更新一致性). */
export function packKeyOf(ref: { ref: string; version: string }): string {
  return `${ref.ref}@${ref.version}`;
}

// --- internals ------------------------------------------------------------------------

/** Page size for the internal full-list loops (offerings / catalog). */
const PAGE_LIMIT = 200;
/** Hard page cap so a pathological table cannot loop forever (200 × 50 = 10k rows). */
const MAX_PAGES = 50;

function fail(code: DiscoverModelsErrorCode, message: string): DiscoverModelsOutcome {
  return { ok: false, error: { code, message } };
}

/** True when the path already carries a scheme + host (mirrors the pipeline's check). */
function isAbsoluteUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/**
 * Every LIVE upstream model name already offered on the channel. Keyset-paged
 * to completion (bounded by {@link MAX_PAGES}).
 */
async function existingUpstreamNames(
  db: DbOrTx,
  queries: DiscoverModelsQueries,
  channelId: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: { createdAt: Date; id: string } | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queries.listSupplyOfferings(
      db,
      { limit: PAGE_LIMIT, cursor },
      {
        channelId,
      },
    );
    for (const row of result.rows) names.add(row.upstreamModelName);
    const last = result.rows.at(-1);
    if (!result.hasMore || last === undefined) break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return names;
}

/**
 * Discover the channel's upstream models. NEVER writes; every config/upstream
 * failure lands in the `ok: false` outcome (the API layer maps codes onto
 * clean 400s), only programmer errors escape.
 */
export async function discoverModels(
  deps: DiscoverModelsDeps,
  subject: DiscoverModelsSubject,
): Promise<DiscoverModelsOutcome> {
  const nowMs = deps.nowMs ?? Date.now;
  const queries: DiscoverModelsQueries = {
    listActiveCredentialsForChannel:
      deps.queries?.listActiveCredentialsForChannel ?? listActiveCredentialsForChannel,
    resolveSupplyCredentialSecret:
      deps.queries?.resolveSupplyCredentialSecret ?? resolveSupplyCredentialSecret,
    listModelSpecs: deps.queries?.listModelSpecs ?? listModelSpecs,
    listSupplyOfferings: deps.queries?.listSupplyOfferings ?? listSupplyOfferings,
  };
  const { channel, provider } = subject;
  const existing = await existingUpstreamNames(deps.db, queries, channel.id);

  // ── source selection: dialect ref → its DSL pack → its discovery draft. ────
  const ref = channel.dialect ?? provider?.defaultDialect ?? null;
  const pack = ref === null ? undefined : deps.packs?.get(packKeyOf(ref));
  const draft = pack === undefined ? undefined : buildDiscoveryRequest(pack);

  if (pack !== undefined && draft !== undefined) {
    // ── dialect_discovery: resolve dialect + ctx exactly like the gateway. ────
    const resolved = resolveDialectForOffering(
      { registry: deps.registry },
      {
        channel: {
          id: channel.id,
          dialect: channel.dialect,
          baseUrl: channel.baseUrl,
          region: channel.region,
        },
        provider,
        nowMs: nowMs(),
      },
    );
    if (!resolved.ok) return fail('dialect_unresolved', resolved.error.message);

    // Credential-pool head (§2.4) — a discovery endpoint authenticates like any call.
    const pool = await queries.listActiveCredentialsForChannel(
      deps.db,
      channel.id,
      new Date(nowMs()),
    );
    const credential = pool[0];
    if (credential === undefined) {
      return fail(
        'no_credential',
        `channel ${channel.id} has no active credential to discover with`,
      );
    }
    const secret = await queries.resolveSupplyCredentialSecret(deps.db, credential.id);
    if (secret === undefined) {
      return fail(
        'secret_unresolvable',
        `credential ${credential.id} secret is unresolvable (vault miss or shape drift)`,
      );
    }

    // Resolve the URL BEFORE aspect ③ (signers bind the absolute URL — the
    // pipeline's resolveDraftUrl discipline).
    const baseUrl = resolved.ctx.baseUrl;
    let located = draft;
    if (!isAbsoluteUrl(draft.path)) {
      if (baseUrl === undefined || baseUrl.length === 0) {
        return fail(
          'discovery_http_error',
          `discovery path "${draft.path}" is relative and channel ${channel.id} has no base_url`,
        );
      }
      located = {
        ...draft,
        path: `${baseUrl.replace(/\/+$/, '')}/${draft.path.replace(/^\/+/, '')}`,
      };
    }
    let injected;
    try {
      injected = resolved.dialect.credentialInjection.injectCredential(
        located,
        secret,
        resolved.ctx,
      );
    } catch (err) {
      return fail(
        'discovery_http_error',
        `credential injection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (injected.method !== 'GET' && injected.method !== 'POST') {
      return fail(
        'discovery_http_error',
        `discovery request method ${injected.method} is not supported (HttpClient carries GET/POST)`,
      );
    }
    const request: HttpRequest = {
      method: injected.method,
      url: composeWireUrl(injected),
      ...(injected.headers !== undefined ? { headers: injected.headers } : {}),
      ...(injected.bodyKind === 'json' && injected.body !== undefined
        ? { body: injected.body }
        : {}),
    };
    const proxyUrl =
      channel.proxyRef !== null && deps.resolveProxyUrl !== undefined
        ? await deps.resolveProxyUrl(channel.proxyRef)
        : undefined;
    if (proxyUrl !== undefined) request.proxyUrl = proxyUrl;

    let status: number;
    let body: unknown;
    try {
      const res = await deps.http.request(request);
      status = res.status;
      body = res.body;
    } catch (err) {
      return fail(
        'discovery_http_error',
        `discovery request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (status < 200 || status >= 300) {
      return fail('discovery_http_error', `discovery endpoint answered HTTP ${String(status)}`);
    }
    const parsed: ProviderModel[] = parseDiscoveredModels(pack, body);
    return {
      ok: true,
      source: 'dialect_discovery',
      models: parsed.map((m) => ({
        upstreamModelName: m.id,
        ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
        source: 'dialect_discovery',
        existsAsOffering: existing.has(m.id),
      })),
    };
  }

  // ── catalog: model_spec by the provider's slug (§10 目录勾选). ────────────────
  const vendor = provider?.slug;
  if (vendor === undefined || vendor.length === 0) {
    return fail(
      'no_catalog_vendor',
      `channel ${channel.id}'s dialect declares no discovery endpoint and its provider has no slug to match the official catalog by`,
    );
  }
  const models: DiscoveredModel[] = [];
  let cursor: { createdAt: Date; id: string } | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await queries.listModelSpecs(deps.db, { vendor }, { limit: PAGE_LIMIT, cursor });
    for (const spec of result.rows) {
      models.push({
        upstreamModelName: spec.modelId,
        ...(spec.displayName !== null ? { displayName: spec.displayName } : {}),
        source: 'catalog',
        existsAsOffering: existing.has(spec.modelId),
      });
    }
    const last = result.rows.at(-1);
    if (!result.hasMore || last === undefined) break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return { ok: true, source: 'catalog', models };
}
