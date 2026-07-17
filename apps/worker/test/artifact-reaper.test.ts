// 批次4 slice5 — §9.4 artifact lifecycle sweep: signed 轨到期 → 标记 expired
// (artifact-layer marking; the succeeded terminal status never moves — §7.1
// 终态禁迁移); public 轨 EXEMPT by the repo feed's construction (豁免清理,
// checksum + lifecycle records retained on the settle event).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifactReaperProcessor } from '../src/processors/artifact-reaper.processor.js';
import type { WorkerRuntime } from '../src/runtime.js';

const { listMock, markMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  markMock: vi.fn(),
}));
vi.mock('@actionow/db', () => ({
  listExpiredSignedArtifactTasks: listMock,
  markTaskArtifactExpired: markMock,
}));

function runtime(): WorkerRuntime {
  return { db: {} } as unknown as WorkerRuntime;
}

const row = (id: string): { id: string } => ({ id });

describe('artifact-reaper processor (§9.4 signed-track expiry)', () => {
  beforeEach(() => {
    listMock.mockReset();
    markMock.mockReset().mockResolvedValue(true);
  });

  it('marks every due SIGNED task expired and reports the count', async () => {
    listMock.mockResolvedValueOnce([row('t1'), row('t2')]).mockResolvedValueOnce([]);
    const marked = await createArtifactReaperProcessor(runtime())();
    expect(marked).toBe(2);
    expect(markMock).toHaveBeenCalledTimes(2);
    expect(markMock).toHaveBeenCalledWith(expect.anything(), 't1');
    expect(markMock).toHaveBeenCalledWith(expect.anything(), 't2');
    // The feed itself is the public-track exemption: the repo query filters
    // artifact_mode='signed', so a public row can never be handed to mark.
    const [, now, limit] = listMock.mock.calls[0] as [unknown, Date, number];
    expect(now).toBeInstanceOf(Date);
    expect(limit).toBeGreaterThan(0);
  });

  it('no due rows → no-op returning 0', async () => {
    listMock.mockResolvedValue([]);
    const marked = await createArtifactReaperProcessor(runtime())();
    expect(marked).toBe(0);
    expect(markMock).not.toHaveBeenCalled();
  });

  it('a batch where EVERY mark loses its race stops the sweep (no infinite re-list)', async () => {
    listMock.mockResolvedValue([row('t1')]);
    markMock.mockResolvedValue(false);
    const marked = await createArtifactReaperProcessor(runtime())();
    expect(marked).toBe(0);
    expect(listMock).toHaveBeenCalledTimes(1); // stopped after the zero-progress batch
  });

  it('drains a backlog across batches within one sweep', async () => {
    const batch = Array.from({ length: 100 }, (_, i) => row(`a${String(i)}`));
    listMock
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([row('tail')])
      .mockResolvedValue([]);
    const marked = await createArtifactReaperProcessor(runtime())();
    expect(marked).toBe(101);
    expect(listMock).toHaveBeenCalledTimes(2); // second batch was short → stop
  });
});
