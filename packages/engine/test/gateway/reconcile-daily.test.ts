// 批次5 slice4 — §9.2 官方渠道日对账比对器 red lines: official offerings are
// re-priced against the official catalog and alert past the threshold; 中转
// (relay) offerings stay monthly-report scope (marked, NEVER day-compared —
// the R4① 砍刀 floor); degraded/usage-less settles are excluded from the
// deviation basis; the UTC day window is exact and malformed dates fail closed.
import type { OfficialModelPriceRow, ReconciliationAggregateRow } from '@actionow/db';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DEVIATION_PCT,
  reconcileDaily,
  type ReconcileDailyDeps,
  utcDayWindow,
} from '../../src/index.js';

const DB = {} as never; // repo mocks never touch it

function aggRow(over: Partial<ReconciliationAggregateRow>): ReconciliationAggregateRow {
  return {
    day: '2026-07-12',
    tenantId: 'tenant-1',
    offeringId: 'off-1',
    channelId: 'chan-1',
    channelName: 'openai-main',
    providerSlug: 'openai',
    modelName: 'gpt-4o',
    settleCount: 1,
    estimatedCount: 0,
    costMissingCount: 0,
    saleSideCredits: 0n,
    costSideCredits: 0n,
    ...over,
  };
}

/** A per-token official row: 1 µUSD/token in, 2 µUSD/token out. */
function officialRow(): OfficialModelPriceRow {
  return {
    scheme: null,
    inputPricePer1m: 1_000_000n,
    outputPricePer1m: 2_000_000n,
    cachedInputPricePer1m: null,
  } as OfficialModelPriceRow;
}

/** usage {1000 in, 500 out} → (1000×1e6 + 500×2e6) / 1e6 = 2000 µcredits expected. */
const USAGE = { input_tokens: 1000, output_tokens: 500 };
const EXPECTED_PER_SETTLE = 2000n;

/** The first per-offering row, fail-loud (noUncheckedIndexedAccess without `!`). */
function firstRow(result: Awaited<ReturnType<typeof reconcileDaily>>) {
  const row = result.perOffering[0];
  if (row === undefined) throw new Error('expected at least one perOffering row');
  return row;
}

interface DepsOptions {
  aggregates?: ReconciliationAggregateRow[];
  samples?: {
    offeringId: string;
    usageVector: Record<string, number> | null;
    costSideCredits: bigint | null;
    estimated: boolean;
  }[];
  official?: OfficialModelPriceRow | undefined;
  offering?: { upstreamModelName: string } | undefined;
  threshold?: number | undefined;
}

interface DepSpies {
  aggregate: ReturnType<typeof vi.fn>;
  samples: ReturnType<typeof vi.fn>;
  offering: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
}

function depsOf(opts: DepsOptions): {
  deps: ReconcileDailyDeps;
  alert: ReturnType<typeof vi.fn>;
  spies: DepSpies;
} {
  const alert = vi.fn();
  const spies = {
    aggregate: vi.fn().mockResolvedValue(opts.aggregates ?? []),
    samples: vi.fn().mockResolvedValue(opts.samples ?? []),
    offering: vi
      .fn()
      .mockResolvedValue('offering' in opts ? opts.offering : { upstreamModelName: 'gpt-4o' }),
    match: vi.fn().mockResolvedValue(opts.official),
  };
  const deps: ReconcileDailyDeps = {
    db: DB,
    repo: {
      aggregateGatewayReconciliation: spies.aggregate as never,
      listGatewaySettleSamples: spies.samples as never,
      getSupplyOfferingById: spies.offering as never,
      matchOfficialPrice: spies.match as never,
    },
    settings:
      opts.threshold === undefined
        ? undefined
        : { get: vi.fn().mockResolvedValue(opts.threshold) as never },
    alert,
  };
  return { deps, alert, spies };
}

describe('utcDayWindow (date 边界)', () => {
  it('produces the exact [00:00Z, +24h) window', () => {
    const { from, to } = utcDayWindow('2026-07-12');
    expect(from.toISOString()).toBe('2026-07-12T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-13T00:00:00.000Z');
  });

  it('rejects malformed dates and calendar-invalid days', () => {
    expect(() => utcDayWindow('2026-7-12')).toThrow(/invalid_input/);
    expect(() => utcDayWindow('not-a-date')).toThrow(/invalid_input/);
    expect(() => utcDayWindow('2026-02-30')).toThrow(/invalid_input/);
  });
});

describe('reconcileDaily (§9.2 官方渠道日比对)', () => {
  it('official offering with deviation above the threshold → alerted + structured alert', async () => {
    // Booked cost 3000 vs expected 2000 → 50% deviation (> default 5%).
    const { deps, alert } = depsOf({
      aggregates: [aggRow({ saleSideCredits: 5000n, costSideCredits: 3000n })],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 3000n, estimated: false },
      ],
      official: officialRow(),
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    expect(result.thresholdPct).toBe(DEFAULT_DEVIATION_PCT);
    expect(result.officialCount).toBe(1);
    expect(result.alertsCount).toBe(1);
    const row = firstRow(result);
    expect(row.scope).toBe('official');
    expect(row.expectedCostCredits).toBe(EXPECTED_PER_SETTLE);
    expect(row.comparedCostCredits).toBe(3000n);
    expect(row.deviationPct).toBeCloseTo(50);
    expect(row.alerted).toBe(true);
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]?.[1]).toMatchObject({
      kind: 'reconciliation.deviation',
      date: '2026-07-12',
      offeringId: 'off-1',
      expectedCostCredits: '2000',
      comparedCostCredits: '3000',
    });
  });

  it('official offering within the threshold → compared but NOT alerted', async () => {
    // Booked 2040 vs expected 2000 → 2% deviation (< default 5%).
    const { deps, alert } = depsOf({
      aggregates: [aggRow({ costSideCredits: 2040n })],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 2040n, estimated: false },
      ],
      official: officialRow(),
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    const row = firstRow(result);
    expect(row.deviationPct).toBeCloseTo(2);
    expect(row.alerted).toBe(false);
    expect(result.alertsCount).toBe(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it('re-prices multiple settles exactly (Σ per-settle official baseline)', async () => {
    const { deps } = depsOf({
      aggregates: [aggRow({ settleCount: 2, costSideCredits: 4000n })],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 2000n, estimated: false },
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 2000n, estimated: false },
      ],
      official: officialRow(),
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    const row = firstRow(result);
    expect(row.comparedSettleCount).toBe(2);
    expect(row.expectedCostCredits).toBe(2n * EXPECTED_PER_SETTLE);
    expect(row.deviationPct).toBe(0);
    expect(row.alerted).toBe(false);
  });

  it('中转渠道 (no official match) → marked relay, NEVER day-compared, never alerted', async () => {
    const { deps, alert, spies } = depsOf({
      aggregates: [
        aggRow({ providerSlug: 'reseller-hub', saleSideCredits: 9999n, costSideCredits: 1n }),
      ],
      official: undefined, // matchOfficialPrice misses → relay
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    expect(result.relayCount).toBe(1);
    expect(result.officialCount).toBe(0);
    const row = firstRow(result);
    expect(row.scope).toBe('relay');
    expect(row.expectedCostCredits).toBeNull();
    expect(row.deviationPct).toBeNull();
    expect(row.alerted).toBe(false);
    expect(row.note).toContain('monthly-report scope');
    // The per-settle feed is never queried when no offering is official.
    expect(spies.samples).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('degraded / usage-less settles are excluded from the deviation basis', async () => {
    const { deps } = depsOf({
      aggregates: [aggRow({ settleCount: 3, costMissingCount: 1, costSideCredits: 2000n })],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 2000n, estimated: false },
        // cost side degraded (对账降级) → review flag, not deviation basis:
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: null, estimated: false },
        // no usage recorded → cannot re-price:
        { offeringId: 'off-1', usageVector: null, costSideCredits: 10n, estimated: true },
      ],
      official: officialRow(),
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    const row = firstRow(result);
    expect(row.comparedSettleCount).toBe(1);
    expect(row.comparedCostCredits).toBe(2000n);
    expect(row.expectedCostCredits).toBe(EXPECTED_PER_SETTLE);
    expect(row.deviationPct).toBe(0);
    expect(row.note).toContain('2 settle(s) not comparable');
  });

  it('official offering with ZERO comparable settles → no deviation, no alert', async () => {
    const { deps, alert } = depsOf({
      aggregates: [aggRow({ costMissingCount: 1, costSideCredits: 0n })],
      samples: [{ offeringId: 'off-1', usageVector: null, costSideCredits: null, estimated: true }],
      official: officialRow(),
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    const row = firstRow(result);
    expect(row.scope).toBe('official');
    expect(row.expectedCostCredits).toBeNull();
    expect(row.deviationPct).toBeNull();
    expect(row.alerted).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it('unresolvable offering (soft-deleted) → scope unknown, not compared', async () => {
    const { deps } = depsOf({
      aggregates: [aggRow({})],
      offering: undefined,
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    expect(result.unknownCount).toBe(1);
    expect(firstRow(result).scope).toBe('unknown');
    expect(firstRow(result).alerted).toBe(false);
  });

  it('threshold comes from settings (RECONCILIATION_DEVIATION_PCT 热读); explicit override wins', async () => {
    // 50% deviation with a 60% threshold → silent.
    const { deps, alert } = depsOf({
      aggregates: [aggRow({ costSideCredits: 3000n })],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 3000n, estimated: false },
      ],
      official: officialRow(),
      threshold: 60,
    });
    const viaSettings = await reconcileDaily(deps, { date: '2026-07-12' });
    expect(viaSettings.thresholdPct).toBe(60);
    expect(viaSettings.alertsCount).toBe(0);
    expect(alert).not.toHaveBeenCalled();

    // Explicit thresholdPct beats settings: 10% < 50% deviation → alerts.
    const explicit = await reconcileDaily(deps, { date: '2026-07-12', thresholdPct: 10 });
    expect(explicit.thresholdPct).toBe(10);
    expect(explicit.alertsCount).toBe(1);
  });

  it('passes the exact UTC day window to the aggregate and sample queries', async () => {
    const { deps, spies } = depsOf({
      aggregates: [aggRow({ costSideCredits: 2000n })],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 2000n, estimated: false },
      ],
      official: officialRow(),
    });

    await reconcileDaily(deps, { date: '2026-07-12' });

    const aggregateWindow = spies.aggregate.mock.calls[0]?.[1] as { from: Date; to: Date };
    expect(aggregateWindow.from.toISOString()).toBe('2026-07-12T00:00:00.000Z');
    expect(aggregateWindow.to.toISOString()).toBe('2026-07-13T00:00:00.000Z');
    const sampleWindow = spies.samples.mock.calls[0]?.[1] as {
      from: Date;
      to: Date;
      offeringIds: string[];
    };
    expect(sampleWindow.from.toISOString()).toBe('2026-07-12T00:00:00.000Z');
    expect(sampleWindow.to.toISOString()).toBe('2026-07-13T00:00:00.000Z');
    expect(sampleWindow.offeringIds).toEqual(['off-1']);
  });

  it('rejects a malformed date before touching the db', async () => {
    const { deps, spies } = depsOf({});
    await expect(reconcileDaily(deps, { date: '2026-13-99' })).rejects.toThrow(/invalid_input/);
    expect(spies.aggregate).not.toHaveBeenCalled();
  });

  it('multi-tenant buckets of one offering collapse into a single comparison row', async () => {
    const { deps } = depsOf({
      aggregates: [
        aggRow({ tenantId: 'tenant-1', costSideCredits: 1000n, saleSideCredits: 1500n }),
        aggRow({ tenantId: 'tenant-2', costSideCredits: 1000n, saleSideCredits: 1500n }),
      ],
      samples: [
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 1000n, estimated: false },
        { offeringId: 'off-1', usageVector: USAGE, costSideCredits: 1000n, estimated: false },
      ],
      official: officialRow(),
    });

    const result = await reconcileDaily(deps, { date: '2026-07-12' });

    expect(result.perOffering).toHaveLength(1);
    const row = firstRow(result);
    expect(row.saleCredits).toBe(3000n);
    expect(row.costCredits).toBe(2000n);
    expect(row.settleCount).toBe(2);
    // Booked 2000 vs expected 4000 → 50% deviation → alerted (default 5%).
    expect(row.expectedCostCredits).toBe(4000n);
    expect(row.alerted).toBe(true);
  });
});
