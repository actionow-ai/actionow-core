import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRelayTraceReaperProcessor } from '../src/processors/relay-trace-reaper.processor.js';
import type { WorkerRuntime } from '../src/runtime.js';

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));
vi.mock('@actionow/db', () => ({ deleteRelayTracesOlderThan: deleteMock }));

const DAY = 86_400_000;

function runtime(days: number | undefined): WorkerRuntime {
  return { db: {}, env: { RELAY_TRACE_RETENTION_DAYS: days } } as unknown as WorkerRuntime;
}

describe('relay-trace-reaper processor', () => {
  beforeEach(() => {
    deleteMock.mockReset();
  });

  it('prunes with a cutoff ≈ now − retention days when configured', async () => {
    deleteMock.mockResolvedValue(7);
    const before = Date.now();
    const removed = await createRelayTraceReaperProcessor(runtime(2))();
    const after = Date.now();

    expect(removed).toBe(7);
    expect(deleteMock).toHaveBeenCalledOnce();
    const cutoff = deleteMock.mock.calls[0]?.[1] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 2 * DAY - 50);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 2 * DAY + 50);
  });

  it('is a no-op (returns 0, never deletes) when retention is unset', async () => {
    const removed = await createRelayTraceReaperProcessor(runtime(undefined))();
    expect(removed).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
