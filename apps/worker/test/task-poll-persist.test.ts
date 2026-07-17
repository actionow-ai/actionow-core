// 批次4 slice5 — the POLL path's §7.5 wiring: createTaskPollProcessor must
// thread a REAL persist hook into TaskRecoveryDeps (转存先于 succeeded on the
// worker recovery lane), built over the runtime's storage/publicBaseUrl/
// mediaTransfer and the ARTIFACT_RETENTION_DAYS dynamic default.
import type { TaskRecoveryDeps } from '@actionow/engine';
import { describe, expect, it, vi } from 'vitest';

import { createTaskPollProcessor } from '../src/processors/task-poll.processor.js';
import type { WorkerRuntime } from '../src/runtime.js';

function runtime(o: { storage?: unknown } = {}): WorkerRuntime {
  return {
    db: {},
    http: {},
    storage: o.storage ?? null,
    publicBaseUrl: 'https://asset.local',
    mediaTransfer: {
      fromUrl: vi.fn(),
      fromBytes: vi.fn(),
    },
    settings: { get: vi.fn().mockResolvedValue(30) },
  } as unknown as WorkerRuntime;
}

describe('task-poll processor — §7.5 persist wiring (poll path)', () => {
  it('threads a live persist hook into the recovery deps', async () => {
    let captured: TaskRecoveryDeps | undefined;
    const sweep = vi.fn((deps: TaskRecoveryDeps) => {
      captured = deps;
      return Promise.resolve({ scanned: 0, claimed: 0, outcomes: {} as never });
    });

    await createTaskPollProcessor(runtime(), sweep)();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(captured?.persist).toBeTypeOf('function');
    expect(captured?.ownerNode).toBeTruthy();
  });

  it('the wired hook is the REAL slice5 hook: non-media outputs no-op ok; media without storage FAILS (require_persist enforceable)', async () => {
    let captured: TaskRecoveryDeps | undefined;
    const sweep = vi.fn((deps: TaskRecoveryDeps) => {
      captured = deps;
      return Promise.resolve({ scanned: 0, claimed: 0, outcomes: {} as never });
    });
    await createTaskPollProcessor(runtime({ storage: null }), sweep)();
    const persist = captured?.persist;
    expect(persist).toBeDefined();
    if (persist === undefined) return;

    const usage = { metrics: {}, billingDims: {}, estimated: false };
    // Non-media output → vacuous ok (chat settles never touch storage).
    await expect(persist({ output: { text: 'hi' }, usage, tenantId: 't1' })).resolves.toEqual({
      ok: true,
    });
    // Media output with storage UNCONFIGURED → {ok:false}: the seam can still
    // enforce require_persist=true 失败即 fail 不扣费.
    const media = {
      kind: 'media',
      assets: [
        { role: 'primary', modality: 'image', url: 'https://up.example/x.png', mime: 'image/png' },
      ],
      usage: { images: 1 },
    };
    const out = await persist({ output: media, usage, tenantId: 't1' });
    expect(out.ok).toBe(false);
  });
});
