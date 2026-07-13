import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createReconcileDailyProcessor } from '../src/processors/reconcile-daily.processor.js';
import type { WorkerRuntime } from '../src/runtime.js';

const { reconcileMock } = vi.hoisted(() => ({ reconcileMock: vi.fn() }));
vi.mock('@actionow/engine', () => ({ reconcileDaily: reconcileMock }));

const EMPTY_RESULT = {
  date: '2026-07-12',
  thresholdPct: 5,
  perOffering: [],
  officialCount: 0,
  relayCount: 0,
  unknownCount: 0,
  alertsCount: 0,
};

function runtime(settings?: { get: ReturnType<typeof vi.fn> }): WorkerRuntime {
  return { db: {}, env: {}, settings } as unknown as WorkerRuntime;
}

describe('reconcile-daily processor', () => {
  beforeEach(() => {
    reconcileMock.mockReset();
    reconcileMock.mockResolvedValue(EMPTY_RESULT);
  });

  it('reconciles the PREVIOUS complete UTC day (not the in-progress one)', async () => {
    // Clock pinned mid-day 2026-07-13 UTC → the sweep reconciles 2026-07-12.
    const now = (): number => Date.parse('2026-07-13T10:30:00.000Z');
    await createReconcileDailyProcessor(runtime(), now)();

    expect(reconcileMock).toHaveBeenCalledOnce();
    expect(reconcileMock.mock.calls[0]?.[1]).toEqual({ date: '2026-07-12' });
  });

  it('crosses month boundaries correctly (first-of-month sweep → last day of previous month)', async () => {
    const now = (): number => Date.parse('2026-08-01T00:05:00.000Z');
    await createReconcileDailyProcessor(runtime(), now)();
    expect(reconcileMock.mock.calls[0]?.[1]).toEqual({ date: '2026-07-31' });
  });

  it('threads the runtime settings resolver into the engine deps (阈值热读)', async () => {
    const settings = { get: vi.fn() };
    await createReconcileDailyProcessor(runtime(settings))();

    const deps = reconcileMock.mock.calls[0]?.[0] as { settings?: unknown };
    expect(deps.settings).toBe(settings);
  });

  it('returns the engine result for BullMQ job inspection', async () => {
    const result = await createReconcileDailyProcessor(runtime())();
    expect(result).toBe(EMPTY_RESULT);
  });
});
