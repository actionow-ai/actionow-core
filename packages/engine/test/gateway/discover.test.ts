// 批次5 slice2 — discoverModels (discover.ts): the §10 发现模型 seam. Locks:
//   - the DSL path (pack WITH a discovery declaration): buildDiscoveryRequest →
//     ctx resolution → credential injection through the dialect's OWN aspect ③
//     → ONE authenticated GET → parseDiscoveredModels;
//   - the catalog path (code-aspect dialect / pack WITHOUT discovery): model_spec
//     rows by the provider slug — no HTTP at all;
//   - existsAsOffering marking against the channel's LIVE offerings (paged);
//   - explainable refusals: no credential / vault miss / non-2xx / no vendor.
// POISONED_DB everywhere — discovery owns db READS only, all through fakes.
import type { SupplyCredentialRow, SupplyOfferingRow } from '@actionow/db';
import type { ModelSpecRow } from '@actionow/db';
import { loadDialectPack, registerPack } from '@actionow/spi';
import { describe, expect, it } from 'vitest';

import type { DiscoverModelsDeps, DiscoverModelsSubject } from '../../src/index.js';
import { discoverModels, packKeyOf } from '../../src/index.js';
import { credential, NOW } from '../planner/supply-fixtures.js';
import type { FakeHttpScript } from './gateway-fixtures.js';
import { fakeHttp, POISONED_DB, registryWith, stubDialect } from './gateway-fixtures.js';

// --- fixtures -----------------------------------------------------------------------

/** A minimal DSL pack WITH a discovery declaration (bearer auth, one chat op). */
const DISCOVERY_PACK_YAML = `
ref: discoverer
version: 1.0.0
auth:
  scheme: bearer
errorTable:
  fallback: { code: upstream_error, retryable: false, failover: false }
operations:
  chat.completions:
    fetchModes: [direct]
    request:
      path: /chat
      body: { upstream_model_name: $.model }
    response: {}
discovery:
  request:
    path: /models
    query: { page_size: '100' }
  modelsPath: $.data
  idPath: $.id
  displayNamePath: $.name
`;

/** The same pack WITHOUT the discovery declaration (→ catalog path). */
const NO_DISCOVERY_PACK_YAML = DISCOVERY_PACK_YAML.slice(
  0,
  DISCOVERY_PACK_YAML.indexOf('discovery:'),
);

function offeringRow(
  upstreamModelName: string,
  id = `off-${upstreamModelName}`,
): SupplyOfferingRow {
  return {
    id,
    modelId: 'model-1',
    channelId: 'chan-1',
    status: 'draft',
    upstreamModelName,
    fetchProfile: { mode: 'direct' },
    timeoutBudgetSeconds: null,
    paramDeclarations: [],
    costPriceCardId: null,
    maxConcurrency: null,
    weight: 1,
    tier: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function specRow(modelId: string, displayName: string | null = null): ModelSpecRow {
  return {
    id: `spec-${modelId}`,
    vendor: 'mockbrand',
    modelId,
    displayName,
    family: null,
    type: 'text',
    inputModalities: null,
    outputModalities: null,
    mediaOptions: null,
    keyParams: null,
    features: null,
    parameterRules: null,
    sources: null,
    status: null,
    contextWindow: null,
    maxOutput: null,
    intro: null,
    confidence: 'secondary',
    billingEligible: false,
    asOf: null,
    sourceUrl: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

interface HarnessInput {
  packYaml?: string | undefined;
  http?: FakeHttpScript;
  offerings?: SupplyOfferingRow[][];
  specs?: ModelSpecRow[];
  noCredential?: boolean;
  noSecret?: boolean;
  channelDialect?: { ref: string; version: string } | null;
  providerSlug?: string | undefined;
  baseUrl?: string | null;
}

function harness(o: HarnessInput = {}): {
  deps: DiscoverModelsDeps;
  subject: DiscoverModelsSubject;
  http: ReturnType<typeof fakeHttp>;
  specCalls: { vendor?: string | undefined }[];
} {
  const http = fakeHttp(
    o.http ?? {
      responses: [{ status: 200, body: { data: [{ id: 'up-a', name: 'Up A' }, { id: 'up-b' }] } }],
    },
  );
  const registry = registryWith(stubDialect());
  const packs = new Map<string, ReturnType<typeof loadDialectPack>>();
  if (o.packYaml !== undefined) {
    const pack = registerPack(registry, o.packYaml);
    const loaded = loadDialectPack(o.packYaml);
    packs.set(packKeyOf(pack), loaded);
  }
  // Offering pages consumed in order (default: one page, one existing name).
  const offeringPages = o.offerings ?? [[offeringRow('up-a')]];
  let offeringCall = 0;
  const specCalls: { vendor?: string | undefined }[] = [];
  const credRow: SupplyCredentialRow = credential('cred-1', 'chan-1');
  const deps: DiscoverModelsDeps = {
    db: POISONED_DB,
    registry,
    http,
    packs,
    nowMs: () => NOW.getTime(),
    queries: {
      listSupplyOfferings: () => {
        const page = offeringPages[Math.min(offeringCall, offeringPages.length - 1)] ?? [];
        offeringCall += 1;
        return Promise.resolve({ rows: page, hasMore: offeringCall < offeringPages.length });
      },
      listModelSpecs: (_db, filter) => {
        specCalls.push({ vendor: filter.vendor });
        return Promise.resolve({ rows: o.specs ?? [], hasMore: false });
      },
      listActiveCredentialsForChannel: () =>
        Promise.resolve(o.noCredential === true ? [] : [credRow]),
      resolveSupplyCredentialSecret: () =>
        Promise.resolve(
          o.noSecret === true ? undefined : ({ scheme: 'bearer', api_key: 'sk-disc' } as const),
        ),
    },
  };
  const dialect =
    o.channelDialect !== undefined
      ? o.channelDialect
      : o.packYaml !== undefined
        ? { ref: 'discoverer', version: '1.0.0' }
        : { ref: 'mock.dialect', version: 'v1' };
  const subject: DiscoverModelsSubject = {
    channel: {
      id: 'chan-1',
      dialect,
      baseUrl: o.baseUrl !== undefined ? o.baseUrl : 'https://upstream.test/v1',
      region: null,
      proxyRef: null,
      tenantId: null,
    },
    provider: {
      slug: o.providerSlug ?? 'mockbrand',
      defaultDialect: null,
    },
  };
  return { deps, subject, http, specCalls };
}

// --- DSL discovery path ------------------------------------------------------------

describe('discoverModels — dialect discovery endpoint (DSL pack)', () => {
  it('fetches the declared endpoint WITH the injected credential and parses ProviderModels', async () => {
    const { deps, subject, http } = harness({ packYaml: DISCOVERY_PACK_YAML });
    const outcome = await discoverModels(deps, subject);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.source).toBe('dialect_discovery');
    expect(outcome.models).toEqual([
      {
        upstreamModelName: 'up-a',
        displayName: 'Up A',
        source: 'dialect_discovery',
        existsAsOffering: true, // the channel already offers up-a
      },
      { upstreamModelName: 'up-b', source: 'dialect_discovery', existsAsOffering: false },
    ]);
    // EXACTLY one HTTP exchange: the declared GET, base-url-joined, query
    // carried, and authenticated through the pack's OWN aspect ③.
    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req?.url).toBe('https://upstream.test/v1/models?page_size=100');
    expect(req?.headers?.Authorization).toBe('Bearer sk-disc');
  });

  it('pages the channel offerings to completion before marking existsAsOffering', async () => {
    const { deps, subject } = harness({
      packYaml: DISCOVERY_PACK_YAML,
      offerings: [[offeringRow('up-a')], [offeringRow('up-b', 'off-2')]],
    });
    const outcome = await discoverModels(deps, subject);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.models.map((m) => m.existsAsOffering)).toEqual([true, true]);
  });

  it('refuses without an active credential (no upstream byte)', async () => {
    const { deps, subject, http } = harness({
      packYaml: DISCOVERY_PACK_YAML,
      noCredential: true,
    });
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'no_credential' } });
    expect(http.requests).toHaveLength(0);
  });

  it('refuses on a vault miss (secret unresolvable)', async () => {
    const { deps, subject } = harness({ packYaml: DISCOVERY_PACK_YAML, noSecret: true });
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'secret_unresolvable' } });
  });

  it('surfaces a non-2xx discovery answer as discovery_http_error', async () => {
    const { deps, subject } = harness({
      packYaml: DISCOVERY_PACK_YAML,
      http: { responses: [{ status: 503, body: {} }] },
    });
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'discovery_http_error' } });
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('503');
  });

  it('surfaces a transport throw as discovery_http_error', async () => {
    const { deps, subject } = harness({
      packYaml: DISCOVERY_PACK_YAML,
      http: { requestThrows: new Error('ECONNREFUSED') },
    });
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'discovery_http_error' } });
  });

  it('refuses a relative discovery path when the channel has no base_url', async () => {
    const { deps, subject } = harness({ packYaml: DISCOVERY_PACK_YAML, baseUrl: null });
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'discovery_http_error' } });
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('base_url');
  });

  it('an unregistered dialect pin fails dialect_unresolved (deploy drift, not blamed on the upstream)', async () => {
    const { deps, subject } = harness({ packYaml: DISCOVERY_PACK_YAML });
    // Pack present under the key, but the channel pins a version the registry lacks.
    subject.channel.dialect = { ref: 'discoverer', version: '9.9.9' };
    (deps.packs as Map<string, unknown>).set(
      'discoverer@9.9.9',
      loadDialectPack(DISCOVERY_PACK_YAML.replace('version: 1.0.0', 'version: 9.9.9')),
    );
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'dialect_unresolved' } });
  });
});

// --- catalog path -------------------------------------------------------------------

describe('discoverModels — catalog pick (code-aspect dialect / no discovery declaration)', () => {
  it('lists model_spec rows by the provider slug — no HTTP at all', async () => {
    const { deps, subject, http, specCalls } = harness({
      specs: [specRow('cat-a', 'Cat A'), specRow('cat-b')],
      offerings: [[offeringRow('cat-b')]],
    });
    const outcome = await discoverModels(deps, subject);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.source).toBe('catalog');
    expect(outcome.models).toEqual([
      {
        upstreamModelName: 'cat-a',
        displayName: 'Cat A',
        source: 'catalog',
        existsAsOffering: false,
      },
      { upstreamModelName: 'cat-b', source: 'catalog', existsAsOffering: true },
    ]);
    expect(specCalls).toEqual([{ vendor: 'mockbrand' }]);
    expect(http.requests).toHaveLength(0);
  });

  it('a pack WITHOUT a discovery declaration also falls back to the catalog', async () => {
    const { deps, subject, http } = harness({
      packYaml: NO_DISCOVERY_PACK_YAML,
      specs: [specRow('cat-a')],
      offerings: [[]],
    });
    const outcome = await discoverModels(deps, subject);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.source).toBe('catalog');
    expect(outcome.models.map((m) => m.upstreamModelName)).toEqual(['cat-a']);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses when neither a discovery endpoint nor a provider slug exists', async () => {
    const { deps, subject } = harness({ offerings: [[]] });
    subject.provider = { defaultDialect: null };
    const outcome = await discoverModels(deps, subject);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'no_catalog_vendor' } });
  });
});
