// §8 candidate assembly unit tests (model-supply-greenfield 批次3 slice 3a).
// Covers the stage pipeline over handwritten fake queries (no live db):
// breaker three-state filtering (pure breaker.ts verdicts), credential-pool
// all-cold elimination + per-channel memoization, route-tag zero-match 400,
// §4 rule 4 error passthrough, and normal assembly output.
import type { CanonicalParam, CanonicalParamValue, Operation } from '@actionow/contracts';
import type {
  DbOrTx,
  RoutingCandidate,
  SupplyCredentialRow,
  SupplyOfferingBreakerRow,
} from '@actionow/db';
import { describe, expect, it } from 'vitest';

import {
  assembleCandidates,
  type AssembleDeps,
  type AssembleInput,
  breakerSnapshotFromRow,
  DEFAULT_BREAKER_CONFIG,
} from '../../src/index.js';
import { breakerRow, credential, modelOp, NOW, offering } from './supply-fixtures.js';

const OP: Operation = 'images.generation';
const DB = {} as unknown as DbOrTx;

const SIZE_PARAM: CanonicalParam = {
  name: 'size',
  type: 'enum',
  billingRelevant: true,
  required: false,
  values: ['720p', '1080p'],
};

function explicit(value: unknown): CanonicalParamValue {
  return { value, isDefault: false };
}

/**
 * Fake slice-1 queries: fixed candidates, per-channel pools (absent channel →
 * one active key), and a breaker map. Records credential-pool lookups so the
 * memoization test can count round-trips.
 */
function fakeDeps(o: {
  candidates: RoutingCandidate[];
  pools?: Record<string, SupplyCredentialRow[]>;
  breakers?: Map<string, SupplyOfferingBreakerRow>;
}): { deps: AssembleDeps; credentialCalls: string[] } {
  const credentialCalls: string[] = [];
  const deps: AssembleDeps = {
    db: DB,
    now: () => NOW,
    queries: {
      listRoutingCandidates: () => Promise.resolve(o.candidates),
      listActiveCredentialsForChannel: (_db, channelId) => {
        credentialCalls.push(channelId);
        return Promise.resolve(o.pools?.[channelId] ?? [credential(`k-${channelId}`, channelId)]);
      },
      getSupplyOfferingBreakers: () => Promise.resolve(o.breakers ?? new Map()),
    },
  };
  return { deps, credentialCalls };
}

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    operation: OP,
    model: { id: 'model-1', operations: [modelOp(OP, { params: [SIZE_PARAM] })] },
    requestParams: {},
    tenantId: 'tenant-1',
    ...overrides,
  };
}

describe('assembleCandidates — breaker-closed filter (§8, pure breaker.ts verdicts)', () => {
  it('eliminates an open breaker still inside its cooldown', async () => {
    // consecutiveOpens=1 → cooldown 5s (default cfg); opened 1s ago → cooling.
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-1' })],
      breakers: new Map([
        [
          'off-1',
          breakerRow('off-1', {
            state: 'open',
            openedAt: new Date(NOW.getTime() - 1_000),
            consecutiveOpens: 1,
          }),
        ],
      ]),
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toBeUndefined();
    expect(result.rejected).toEqual([
      expect.objectContaining({ offeringId: 'off-1', stage: 'breaker' }),
    ]);
  });

  it('passes an open breaker whose cooldown has elapsed (half-open probe through the normal pool)', async () => {
    // consecutiveOpens=1 → cooldown 5s; opened 6s ago → eligible.
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-1' })],
      breakers: new Map([
        [
          'off-1',
          breakerRow('off-1', {
            state: 'open',
            openedAt: new Date(NOW.getTime() - 6_000),
            consecutiveOpens: 1,
          }),
        ],
      ]),
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates.map((c) => c.offering.id)).toEqual(['off-1']);
    expect(result.rejected).toHaveLength(0);
  });

  it('derives the exponential cooldown from consecutive_opens (trip 3 → 20s, still cooling at 10s)', async () => {
    // cooldownMs(default, 3-1) = 5s × 2² = 20s; opened 10s ago → still cooling.
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-1' })],
      breakers: new Map([
        [
          'off-1',
          breakerRow('off-1', {
            state: 'open',
            openedAt: new Date(NOW.getTime() - 10_000),
            consecutiveOpens: 3,
          }),
        ],
      ]),
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(0);
    expect(result.rejected[0]?.stage).toBe('breaker');
  });

  it('passes a half_open breaker (probe routes through in-pool rotation, §2.5)', async () => {
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-1' })],
      breakers: new Map([
        [
          'off-1',
          breakerRow('off-1', {
            state: 'half_open',
            openedAt: new Date(NOW.getTime() - 30_000),
            halfOpenSuccesses: 1,
            consecutiveOpens: 2,
          }),
        ],
      ]),
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates.map((c) => c.offering.id)).toEqual(['off-1']);
  });

  it('passes a candidate with no breaker row (closed initial state)', async () => {
    const { deps } = fakeDeps({ candidates: [offering({ id: 'off-1' })] });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates.map((c) => c.offering.id)).toEqual(['off-1']);
    expect(result.rejected).toHaveLength(0);
  });
});

describe('assembleCandidates — credential-pool-not-all-cold filter (§2.4)', () => {
  it('eliminates an offering whose channel pool is fully cold/empty — breaker untouched', async () => {
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-1', channelId: 'chan-cold' })],
      pools: { 'chan-cold': [] },
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toBeUndefined();
    expect(result.rejected).toEqual([
      expect.objectContaining({ offeringId: 'off-1', stage: 'credentials' }),
    ]);
  });

  it('passes a non-empty pool and reports its size', async () => {
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-1', channelId: 'chan-1' })],
      pools: { 'chan-1': [credential('k1', 'chan-1'), credential('k2', 'chan-1')] },
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.activeCredentialCount).toBe(2);
  });

  it('memoizes the pool per channel — offerings sharing a channel cost ONE lookup', async () => {
    const { deps, credentialCalls } = fakeDeps({
      candidates: [
        offering({ id: 'off-1', channelId: 'chan-shared' }),
        offering({ id: 'off-2', channelId: 'chan-shared' }),
        offering({ id: 'off-3', channelId: 'chan-other' }),
      ],
    });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(3);
    expect(credentialCalls).toEqual(['chan-shared', 'chan-other']);
  });
});

describe('assembleCandidates — route-tag narrow-only pin (§8 钉选)', () => {
  it('answers 400 invalid_input when a route tag is given and matches nothing', async () => {
    const { deps } = fakeDeps({ candidates: [] });
    const result = await assembleCandidates(deps, input({ routeTag: 'eu-only' }));
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toMatchObject({
      code: 'invalid_input',
      retryable: false,
      failover: false,
      details: { routeTag: 'eu-only' },
    });
    expect(result.error?.message).toContain('eu-only');
    expect(result.error?.message).toContain('route tag');
  });

  it('does NOT error on an empty candidate set when no route tag was given', async () => {
    const { deps } = fakeDeps({ candidates: [] });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});

describe('assembleCandidates — §8 failover exclusion (批次4 loop)', () => {
  it('drops already-attempted offerings with an `excluded` rejection; survivors assemble normally', async () => {
    const { deps } = fakeDeps({
      candidates: [offering({ id: 'off-A' }), offering({ id: 'off-B' })],
    });
    const result = await assembleCandidates(deps, input({ excludeOfferingIds: ['off-A'] }));
    expect(result.candidates.map((c) => c.offering.id)).toEqual(['off-B']);
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ offeringId: 'off-A', stage: 'excluded' }),
    );
    expect(result.error).toBeUndefined();
  });

  it('ALL candidates excluded → empty set WITHOUT an error (exhaustion, the orchestrator answers)', async () => {
    const { deps } = fakeDeps({ candidates: [offering({ id: 'off-A' })] });
    const result = await assembleCandidates(deps, input({ excludeOfferingIds: ['off-A'] }));
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('exclusion is judged AFTER the route-tag pin: a tag matching only excluded offerings is exhaustion, not a 400', async () => {
    const { deps } = fakeDeps({ candidates: [offering({ id: 'off-A' })] });
    const result = await assembleCandidates(
      deps,
      input({ routeTag: 'eu', excludeOfferingIds: ['off-A'] }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toBeUndefined(); // NOT invalid_input — the tag DID match supply
  });
});

describe('assembleCandidates — §3 paradigm×fetch servability filter (FOUND-1)', () => {
  const MIXED = [
    offering({ id: 'off-stream', channelId: 'chan-1', mode: 'stream' }),
    offering({ id: 'off-direct', channelId: 'chan-2', mode: 'direct' }),
    offering({ id: 'off-poll', channelId: 'chan-3', mode: 'submit_poll' }),
    offering({ id: 'off-cb', channelId: 'chan-4', mode: 'submit_callback' }),
  ];

  it('stream paradigm: submit_poll/submit_callback offerings never enter the set; stream/direct survive', async () => {
    const { deps } = fakeDeps({ candidates: MIXED.map((c) => ({ ...c })) });
    const result = await assembleCandidates(deps, input({ externalParadigm: 'stream' }));
    expect(result.candidates.map((c) => c.offering.id)).toEqual(['off-stream', 'off-direct']);
    expect(result.error).toBeUndefined();
    expect(result.rejected).toEqual([
      expect.objectContaining({ offeringId: 'off-poll', stage: 'servability' }),
      expect.objectContaining({ offeringId: 'off-cb', stage: 'servability' }),
    ]);
  });

  it('task paradigm: a stream-fetch offering is filtered; submits and direct survive', async () => {
    const { deps } = fakeDeps({ candidates: MIXED.map((c) => ({ ...c })) });
    const result = await assembleCandidates(deps, input({ externalParadigm: 'task' }));
    expect(result.candidates.map((c) => c.offering.id)).toEqual([
      'off-direct',
      'off-poll',
      'off-cb',
    ]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ offeringId: 'off-stream', stage: 'servability' }),
    ]);
  });

  it('sync paradigm keeps ALL fetch modes (drain/block-poll serve them — 不被误过滤)', async () => {
    const { deps } = fakeDeps({ candidates: MIXED.map((c) => ({ ...c })) });
    const result = await assembleCandidates(deps, input({ externalParadigm: 'sync' }));
    expect(result.candidates.map((c) => c.offering.id)).toEqual([
      'off-stream',
      'off-direct',
      'off-poll',
      'off-cb',
    ]);
    expect(result.rejected).toHaveLength(0);
  });

  it('stream paradigm over SUBMIT-ONLY supply → empty set WITHOUT an error (the orchestrator answers no-supply once — zero hold churn)', async () => {
    const { deps, credentialCalls } = fakeDeps({
      candidates: [
        offering({ id: 'off-poll', mode: 'submit_poll' }),
        offering({ id: 'off-cb', channelId: 'chan-2', mode: 'submit_callback' }),
      ],
    });
    const result = await assembleCandidates(deps, input({ externalParadigm: 'stream' }));
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toBeUndefined();
    expect(result.rejected.map((r) => r.stage)).toEqual(['servability', 'servability']);
    // the filter runs BEFORE the I/O stages — no credential lookups were wasted
    expect(credentialCalls).toEqual([]);
  });

  it('absent externalParadigm → no servability filtering (direct assembly callers unchanged)', async () => {
    const { deps } = fakeDeps({ candidates: MIXED.map((c) => ({ ...c })) });
    const result = await assembleCandidates(deps, input());
    expect(result.candidates).toHaveLength(4);
    expect(result.rejected).toHaveLength(0);
  });
});

describe('assembleCandidates — §4 parameter filtering integration', () => {
  it('passes the unsupported_parameter error through verbatim on total annihilation (§4 rule 4)', async () => {
    // Offering pins the billing param to 720p; the request explicitly asks 1080p.
    const { deps } = fakeDeps({
      candidates: [
        offering({
          id: 'off-1',
          declarations: [
            { param: 'size', origin: 'upstream', rule: { kind: 'fixed', value: '720p' } },
          ],
        }),
      ],
    });
    const result = await assembleCandidates(
      deps,
      input({ requestParams: { size: explicit('1080p') } }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toMatchObject({ code: 'unsupported_parameter' });
    expect(result.error?.details).toMatchObject({ excludedBy: { size: ['off-1'] } });
    expect(result.rejected).toEqual([
      expect.objectContaining({ offeringId: 'off-1', stage: 'params', param: 'size' }),
    ]);
  });

  it('assembles survivors with their EffectiveParams + billingDims', async () => {
    const { deps } = fakeDeps({
      candidates: [
        offering({
          id: 'off-1',
          declarations: [
            {
              param: 'size',
              origin: 'upstream',
              rule: { kind: 'domain', values: ['720p', '1080p'] },
            },
          ],
        }),
        offering({
          id: 'off-2',
          channelId: 'chan-2',
          declarations: [
            { param: 'size', origin: 'upstream', rule: { kind: 'fixed', value: '720p' } },
          ],
        }),
      ],
    });
    const result = await assembleCandidates(
      deps,
      input({ requestParams: { size: explicit('720p') } }),
    );
    expect(result.error).toBeUndefined();
    expect(result.candidates.map((c) => c.offering.id)).toEqual(['off-1', 'off-2']);
    for (const candidate of result.candidates) {
      expect(candidate.effective.canonical).toEqual({ size: '720p' });
      expect(candidate.billingDims).toEqual({ size: '720p' });
      expect(candidate.activeCredentialCount).toBeGreaterThan(0);
    }
  });

  it('echoes lenient-mode drops in warnings (§4 rule 4 丢弃必回显)', async () => {
    const freeform: CanonicalParam = {
      name: 'style',
      type: 'string',
      billingRelevant: false,
      required: false,
    };
    const { deps } = fakeDeps({
      candidates: [
        offering({
          id: 'off-1',
          declarations: [{ param: 'style', origin: 'upstream', rule: { kind: 'unsupported' } }],
        }),
      ],
    });
    const result = await assembleCandidates(
      deps,
      input({
        model: { id: 'model-1', operations: [modelOp(OP, { params: [freeform] })] },
        requestParams: { style: explicit('anime') },
        mode: 'lenient',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings).toEqual([expect.objectContaining({ param: 'style' })]);
  });
});

describe('assembleCandidates — operation surface guard (对外范式挂模型)', () => {
  it('answers 400 invalid_input for an operation the model does not declare', async () => {
    const { deps } = fakeDeps({ candidates: [offering({ id: 'off-1' })] });
    const result = await assembleCandidates(
      deps,
      input({ model: { id: 'model-1', operations: [modelOp('chat.completions')] } }),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.error).toMatchObject({
      code: 'invalid_input',
      retryable: false,
      failover: false,
    });
    expect(result.error?.message).toContain(OP);
  });
});

describe('breakerSnapshotFromRow — persisted row → pure-FSM snapshot', () => {
  it('derives cooldown_until as opened_at + cooldownMs(cfg, consecutive_opens − 1)', () => {
    const openedAt = new Date(NOW.getTime() - 1_000);
    const snap = breakerSnapshotFromRow(
      breakerRow('off-1', { state: 'open', openedAt, consecutiveOpens: 3 }),
      DEFAULT_BREAKER_CONFIG,
    );
    // 5s × 2² = 20s from openedAt.
    expect(snap.cooldownUntil?.getTime()).toBe(openedAt.getTime() + 20_000);
    expect(snap.tripCount).toBe(3);
    expect(snap.state).toBe('open');
  });

  it('degrades an unknown state string to closed (fail-open)', () => {
    const snap = breakerSnapshotFromRow(
      breakerRow('off-1', { state: 'garbled' }),
      DEFAULT_BREAKER_CONFIG,
    );
    expect(snap.state).toBe('closed');
    expect(snap.cooldownUntil).toBeNull();
  });
});
