import { describe, expect, it } from 'vitest';

import {
  AUTH_SCHEMES,
  CHANNEL_STATUSES,
  channelSchema,
  CREDENTIAL_STATUSES,
  credentialSchema,
  credentialSecretSchema,
  FETCH_MODES,
  MODEL_STATUSES,
  MODEL_VISIBILITIES,
  modelSchema,
  OFFERING_STATUSES,
  offeringSchema,
  priceCardSchema,
  priceCardSnapshotRefSchema,
  providerSchema,
} from './supply-entities.js';

const TS = { created_at: '2026-07-10T00:00:00Z', updated_at: '2026-07-10T00:00:00Z' };

// 批次0 freeze guards — additions allowed, reshaping is not.
describe('supply entities frozen vocabulary (批次0)', () => {
  it('AUTH_SCHEMES = the §2.3 five schemes', () => {
    expect(AUTH_SCHEMES).toEqual(['bearer', 'x_api_key', 'query', 'ak_sk', 'oauth']);
  });

  it('FETCH_MODES = the §3 four modes', () => {
    expect(FETCH_MODES).toEqual(['direct', 'stream', 'submit_poll', 'submit_callback']);
  });

  it('lifecycles: offering draft→probing→enabled→disabled; model draft/active/deprecated/disabled', () => {
    expect(OFFERING_STATUSES).toEqual(['draft', 'probing', 'enabled', 'disabled']);
    expect(MODEL_STATUSES).toEqual(['draft', 'active', 'deprecated', 'disabled']);
    expect(CHANNEL_STATUSES).toEqual(['active', 'disabled']);
    expect(CREDENTIAL_STATUSES).toEqual(['active', 'disabled']);
    expect(MODEL_VISIBILITIES).toEqual(['public', 'granted']);
  });
});

describe('providerSchema (§2.2 weak entity)', () => {
  it('parses a provider: brand + versioned default dialect + defaults', () => {
    const p = providerSchema.parse({
      id: 'p1',
      slug: 'volcengine',
      name: '火山引擎',
      icon: null,
      default_dialect: { ref: 'volc', version: '1.0.0' },
      callback_verification: { scheme: 'hmac-sha256', header: 'X-Signature' },
      default_fault_policy_id: null,
      region: 'cn',
      ...TS,
    });
    expect(p.default_dialect.version).toBe('1.0.0');
  });

  it('rejects a dialect ref without a version (§6 registry is ref+version addressed)', () => {
    const out = providerSchema.safeParse({
      id: 'p1',
      slug: 'x',
      name: 'X',
      icon: null,
      default_dialect: { ref: 'x' },
      callback_verification: null,
      default_fault_policy_id: null,
      region: null,
      ...TS,
    });
    expect(out.success).toBe(false);
  });
});

describe('channelSchema (§2.3)', () => {
  const base = {
    id: 'ch1',
    provider_id: 'p1',
    name: 'volc-official',
    dialect: null,
    base_url: 'https://ark.example.com',
    proxy_ref: null,
    region: null,
    auth_scheme: 'ak_sk',
    tenant_id: null,
    route_group_id: null,
    status: 'active',
    ...TS,
  };

  it('platform-operated channel: tenant_id null; tags default []', () => {
    const c = channelSchema.parse(base);
    expect(c.tenant_id).toBeNull();
    expect(c.tags).toEqual([]);
  });

  it('BYOK channel: tenant_id set (offerings become tenant-private)', () => {
    const c = channelSchema.parse({ ...base, tenant_id: 'tenant-9', tags: ['byok'] });
    expect(c.tenant_id).toBe('tenant-9');
  });

  it('rejects an unknown auth scheme', () => {
    expect(channelSchema.safeParse({ ...base, auth_scheme: 'mtls' }).success).toBe(false);
  });
});

describe('credentialSecretSchema (write-side, per-scheme shapes)', () => {
  it('discriminates by scheme: bearer needs api_key, ak_sk needs both keys', () => {
    expect(credentialSecretSchema.parse({ scheme: 'bearer', api_key: 'sk-1' }).scheme).toBe(
      'bearer',
    );
    expect(
      credentialSecretSchema.parse({ scheme: 'ak_sk', access_key: 'ak', secret_key: 'sk' }).scheme,
    ).toBe('ak_sk');
    expect(credentialSecretSchema.safeParse({ scheme: 'bearer' }).success).toBe(false);
    expect(credentialSecretSchema.safeParse({ scheme: 'ak_sk', access_key: 'ak' }).success).toBe(
      false,
    );
  });
});

describe('credentialSchema (§2.4 key pool member)', () => {
  it('carries the quota mirror + cooldown; never secret material', () => {
    const c = credentialSchema.parse({
      id: 'cr1',
      channel_id: 'ch1',
      name: 'key-1',
      secret_hint: 'sk-…f3a9',
      quota: { rpm: 600, tpm: null, max_concurrency: 4 },
      status: 'active',
      cooldown_until: null,
      ...TS,
    });
    expect(c.quota.max_concurrency).toBe(4);
    expect('secret' in c).toBe(false);
    expect(
      credentialSchema.safeParse({
        id: 'cr1',
        channel_id: 'ch1',
        name: 'k',
        secret_hint: null,
        quota: { rpm: null, tpm: null, max_concurrency: null },
        status: 'active',
        cooldown_until: '2026-07-10T00:01:00Z',
        ...TS,
      }).success,
    ).toBe(true);
  });
});

describe('modelSchema (§2.1 product face)', () => {
  const base = {
    id: 'm1',
    name: 'video-gen-pro',
    display_name: 'Video Gen Pro',
    icon: null,
    status: 'active',
    modality: 'video',
    operations: [
      {
        operation: 'video.generation',
        paradigms: ['task'],
        slow: true,
        params: [
          {
            name: 'resolution',
            type: 'enum',
            values: ['720p', '1080p'],
            default: '720p',
            billingRelevant: true,
          },
        ],
      },
    ],
    price_card_id: null,
    modifier_group_id: null,
    max_run_time_seconds: 1800,
    artifact: {},
    fallback_model_ids: [],
    limit_plan_id: null,
    ...TS,
  };

  it('per-operation paradigm set + slow marker + canonical params (§2.1/§4)', () => {
    const m = modelSchema.parse(base);
    expect(m.operations[0]?.slow).toBe(true);
    expect(m.operations[0]?.params[0]?.billingRelevant).toBe(true);
    expect(m.visibility).toBe('public');
    expect(m.artifact).toEqual({ mode: 'signed', retention_days: null });
  });

  it('null price_card_id is legal (needs_pricing gate keeps it un-servable, §10)', () => {
    expect(modelSchema.parse(base).price_card_id).toBeNull();
  });

  it('requires at least one operation surface', () => {
    expect(modelSchema.safeParse({ ...base, operations: [] }).success).toBe(false);
  });

  it('max_run_time hangs on the MODEL (§7.3 — hold TTL decoupled from the 15min default)', () => {
    expect(modelSchema.parse(base).max_run_time_seconds).toBe(1800);
  });
});

describe('offeringSchema (§2.5 hard binding)', () => {
  const base = {
    id: 'of1',
    model_id: 'm1',
    channel_id: 'ch1',
    status: 'enabled',
    upstream_model_name: 'doubao-seedance-pro',
    fetch_profile: { mode: 'submit_poll' },
    timeout_budget_seconds: 900,
    cost_price_card_id: null,
    max_concurrency: 4,
    ...TS,
  };

  it('parses; declarations default [] (缺省 = supports 全域), weight 1 / tier 0', () => {
    const o = offeringSchema.parse(base);
    expect(o.param_declarations).toEqual([]);
    expect(o.weight).toBe(1);
    expect(o.tier).toBe(0);
    expect(o.fetch_profile.mode).toBe('submit_poll');
  });

  it('upstream name mapping is upstream_model_name — no model_map resurrection', () => {
    expect(offeringSchema.parse(base).upstream_model_name).toBe('doubao-seedance-pro');
    expect('model_map' in offeringSchema.shape).toBe(false);
  });

  it('rejects an unknown fetch mode and an unknown lifecycle status', () => {
    expect(offeringSchema.safeParse({ ...base, fetch_profile: { mode: 'webhook' } }).success).toBe(
      false,
    );
    expect(offeringSchema.safeParse({ ...base, status: 'paused' }).success).toBe(false);
  });

  it('carries offering param declarations incl. operator variants (§4)', () => {
    const o = offeringSchema.parse({
      ...base,
      param_declarations: [
        { param: 'resolution', rule: { kind: 'fixed', value: '1080p' } },
        { param: 'resolution', origin: 'operator', rule: { kind: 'fixed', value: '720p' } },
      ],
    });
    expect(o.param_declarations).toHaveLength(2);
    expect(o.param_declarations[1]?.origin).toBe('operator');
  });
});

describe('priceCardSchema (§2.7/§9.2 the sixth table)', () => {
  const base = {
    id: 'pc1',
    name: 'video-gen-pro sale v1',
    method: 'matrix',
    unit: 'video_seconds',
    tier_dims: ['resolution'],
    spec: {
      method: 'matrix',
      key: ['resolution'],
      table: { '720p': 5000, '1080p': 12000 },
    },
    version: 1,
    effective_at: '2026-07-10T00:00:00Z',
    ...TS,
  };

  it('parses: seven-method spec + tier dims = billing_relevant param names; currency defaults usd', () => {
    const c = priceCardSchema.parse(base);
    expect(c.tier_dims).toEqual(['resolution']);
    expect(c.currency).toBe('usd');
    expect(c.version).toBe(1);
  });

  it('rejects method ≠ spec.method (pricebook superRefine precedent)', () => {
    expect(priceCardSchema.safeParse({ ...base, method: 'unit' }).success).toBe(false);
  });

  it('billing events snapshot card id + version, never a live ref (§9.2)', () => {
    const snap = priceCardSnapshotRefSchema.parse({ card_id: 'pc1', version: 1 });
    expect(snap).toEqual({ card_id: 'pc1', version: 1 });
    expect(priceCardSnapshotRefSchema.safeParse({ card_id: 'pc1' }).success).toBe(false);
  });
});
