// 批次4 slice4 — §9.3 task_events retention processor: cutoff = now −
// TASK_EVENTS_RETENTION_DAYS (动态配置 → env → 90-day code default; unlike
// relay_trace this window is NEVER unset — §7.1 不默认永久).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskEventsReaperProcessor } from '../src/processors/task-events-reaper.processor.js';
import type { WorkerRuntime } from '../src/runtime.js';

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));
vi.mock('@actionow/db', () => ({ deleteTaskEventsOlderThan: deleteMock }));

const DAY = 86_400_000;

function runtime(o: { envDays?: number; settingsDays?: number } = {}): WorkerRuntime {
  return {
    db: {},
    env: { TASK_EVENTS_RETENTION_DAYS: o.envDays },
    settings:
      o.settingsDays !== undefined ? { get: vi.fn().mockResolvedValue(o.settingsDays) } : undefined,
  } as unknown as WorkerRuntime;
}

function cutoffOf(): Date {
  return deleteMock.mock.calls[0]?.[1] as Date;
}

describe('task-events-reaper processor', () => {
  beforeEach(() => {
    deleteMock.mockReset().mockResolvedValue(42);
  });

  it('prunes with cutoff ≈ now − admin-configured days (动态配置 wins)', async () => {
    const before = Date.now();
    const removed = await createTaskEventsReaperProcessor(
      runtime({ settingsDays: 7, envDays: 30 }),
    )();
    const after = Date.now();
    expect(removed).toBe(42);
    expect(cutoffOf().getTime()).toBeGreaterThanOrEqual(before - 7 * DAY - 50);
    expect(cutoffOf().getTime()).toBeLessThanOrEqual(after - 7 * DAY + 50);
  });

  it('falls back to the env default when no admin override resolves', async () => {
    const before = Date.now();
    await createTaskEventsReaperProcessor(runtime({ envDays: 30 }))();
    expect(cutoffOf().getTime()).toBeGreaterThanOrEqual(before - 30 * DAY - 50);
  });

  it('NEVER a no-op: unset everywhere → the 90-day code default (不默认永久)', async () => {
    const before = Date.now();
    const removed = await createTaskEventsReaperProcessor(runtime())();
    expect(removed).toBe(42);
    expect(deleteMock).toHaveBeenCalledOnce();
    expect(cutoffOf().getTime()).toBeGreaterThanOrEqual(before - 90 * DAY - 50);
    expect(cutoffOf().getTime()).toBeLessThanOrEqual(Date.now() - 90 * DAY + 50);
  });
});
