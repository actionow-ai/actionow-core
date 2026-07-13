// 批次5 slice4 — the /admin/reconciliation/daily face: query validation
// (date required, YYYY-MM-DD only; threshold override must be a positive
// number), engine delegation, and the bigint → µcredit-string wire rendering
// (renderDailyReport). The comparer's own logic is covered in
// packages/engine/test/gateway/reconcile-daily.test.ts.
import { dailyReconcileReportSchema } from '@actionow/contracts';
import type { DailyReconcileResult } from '@actionow/engine';
import { describe, expect, it, vi } from 'vitest';

import {
  ReconciliationController,
  renderDailyReport,
} from '../src/admin/reconciliation.controller.js';

const RESULT: DailyReconcileResult = {
  date: '2026-07-12',
  thresholdPct: 5,
  perOffering: [
    {
      offeringId: 'off-1',
      providerSlug: 'openai',
      modelName: 'gpt-4o',
      channelName: 'openai-main',
      scope: 'official',
      settleCount: 3,
      estimatedCount: 1,
      costMissingCount: 1,
      saleCredits: 5000n,
      costCredits: 3000n,
      comparedSettleCount: 2,
      comparedCostCredits: 2800n,
      expectedCostCredits: 2000n,
      deviationPct: 40,
      alerted: true,
      note: '1 settle(s) not comparable (missing usage / degraded cost / unpriceable spec)',
    },
    {
      offeringId: 'off-2',
      providerSlug: 'reseller-hub',
      modelName: 'gpt-4o',
      channelName: 'reseller',
      scope: 'relay',
      settleCount: 1,
      estimatedCount: 0,
      costMissingCount: 0,
      saleCredits: 100n,
      costCredits: 60n,
      comparedSettleCount: 0,
      comparedCostCredits: 0n,
      expectedCostCredits: null,
      deviationPct: null,
      alerted: false,
    },
  ],
  officialCount: 1,
  relayCount: 1,
  unknownCount: 0,
  alertsCount: 1,
};

function controllerWith(mock: ReturnType<typeof vi.fn>): ReconciliationController {
  const controller = new ReconciliationController({} as never, undefined);
  (controller as unknown as { queries: { reconcileDaily: unknown } }).queries.reconcileDaily = mock;
  return controller;
}

/** Indexed row access, fail-loud (noUncheckedIndexedAccess without `!`). */
function rowAt<T>(rows: T[], i: number): T {
  const row = rows[i];
  if (row === undefined) throw new Error(`expected a row at index ${String(i)}`);
  return row;
}

describe('renderDailyReport (wire rendering)', () => {
  it('renders bigints as µcredit strings and validates against the contract', () => {
    const report = renderDailyReport(RESULT);
    expect(() => dailyReconcileReportSchema.parse(report)).not.toThrow();

    const official = rowAt(report.rows, 0);
    expect(official.sale_credits).toBe('5000');
    expect(official.cost_credits).toBe('3000');
    expect(official.compared_cost_credits).toBe('2800');
    expect(official.expected_cost_credits).toBe('2000');
    expect(official.deviation_pct).toBe(40);
    expect(official.alerted).toBe(true);
    expect(official.note).toContain('not comparable');

    const relay = rowAt(report.rows, 1);
    expect(relay.scope).toBe('relay');
    expect(relay.expected_cost_credits).toBeNull();
    expect(relay.deviation_pct).toBeNull();
    expect(relay.note).toBeUndefined();

    expect(report.alerts_count).toBe(1);
    expect(report.threshold_pct).toBe(5);
  });
});

describe('GET /admin/reconciliation/daily (controller validation + delegation)', () => {
  it('requires a date', async () => {
    const controller = controllerWith(vi.fn());
    await expect(controller.daily(undefined)).rejects.toThrow(/date.*required/);
    await expect(controller.daily('')).rejects.toThrow(/date.*required/);
  });

  it('rejects a non-positive / non-numeric threshold override', async () => {
    const controller = controllerWith(vi.fn());
    await expect(controller.daily('2026-07-12', 'abc')).rejects.toThrow(/threshold_pct/);
    await expect(controller.daily('2026-07-12', '-5')).rejects.toThrow(/threshold_pct/);
    await expect(controller.daily('2026-07-12', '0')).rejects.toThrow(/threshold_pct/);
  });

  it('delegates date + threshold to reconcileDaily and renders the result', async () => {
    const mock = vi.fn().mockResolvedValue(RESULT);
    const controller = controllerWith(mock);

    const report = await controller.daily('2026-07-12', '12.5');

    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]?.[1]).toEqual({ date: '2026-07-12', thresholdPct: 12.5 });
    expect(report.date).toBe('2026-07-12');
    expect(report.rows).toHaveLength(2);
  });

  it("maps the engine's invalid_input DomainError (bad calendar day) to the 400 envelope", async () => {
    // The REAL engine reconcileDaily rejects malformed dates before any db read
    // — exercise it end-to-end through the controller (db never touched).
    const controller = new ReconciliationController({} as never, undefined);
    await expect(controller.daily('2026-02-30')).rejects.toThrow(/not a valid UTC calendar day/);
  });
});
