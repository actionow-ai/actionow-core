import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileLifecycleReaperProcessor } from '../src/processors/file-lifecycle-reaper.processor.js';
import type { WorkerRuntime } from '../src/runtime.js';

const { listTenantsMock, listFilesMock, markDeletedMock } = vi.hoisted(() => ({
  listTenantsMock: vi.fn(),
  listFilesMock: vi.fn(),
  markDeletedMock: vi.fn(),
}));
vi.mock('@actionow/db', () => ({
  listTenantsWithFileTtl: listTenantsMock,
  listLiveFilesOlderThanForTenant: listFilesMock,
  markFileObjectsDeleted: markDeletedMock,
}));

const DAY = 86_400_000;

/** A fake runtime with a stub storage provider (or null) + the platform-default env knob. */
function runtime(opts: {
  platformDefault?: number;
  storage?: { delete: (key: string) => Promise<void> } | null;
}): WorkerRuntime {
  return {
    db: {},
    env: { FILE_RETENTION_DAYS: opts.platformDefault },
    storage:
      opts.storage === undefined ? { delete: vi.fn().mockResolvedValue(undefined) } : opts.storage,
  } as unknown as WorkerRuntime;
}

describe('file-lifecycle-reaper processor', () => {
  beforeEach(() => {
    listTenantsMock.mockReset();
    listFilesMock.mockReset();
    markDeletedMock.mockReset();
  });

  it('is a no-op (returns 0, never lists/deletes files) when no tenant is eligible', async () => {
    listTenantsMock.mockResolvedValue([]);
    const removed = await createFileLifecycleReaperProcessor(runtime({}))();
    expect(removed).toBe(0);
    expect(listFilesMock).not.toHaveBeenCalled();
    expect(markDeletedMock).not.toHaveBeenCalled();
  });

  it('passes the platform default through to the eligibility query', async () => {
    listTenantsMock.mockResolvedValue([]);
    await createFileLifecycleReaperProcessor(runtime({ platformDefault: 30 }))();
    expect(listTenantsMock).toHaveBeenCalledOnce();
    expect(listTenantsMock.mock.calls[0]?.[1]).toBe(30);
  });

  it('sweeps an eligible tenant: cutoff ≈ now − ttl*DAY, bucket-delete per key, soft-delete the ids', async () => {
    listTenantsMock.mockResolvedValue([{ tenantId: 't1', ttlDays: 2 }]);
    const files = [
      { id: 'f1', key: 'k1' },
      { id: 'f2', key: 'k2' },
    ];
    // First batch returns the files (< limit ⇒ loop terminates after one batch).
    listFilesMock.mockResolvedValueOnce(files);
    markDeletedMock.mockResolvedValue(2);
    const storageDelete = vi.fn().mockResolvedValue(undefined);

    const before = Date.now();
    const removed = await createFileLifecycleReaperProcessor(
      runtime({ storage: { delete: storageDelete } }),
    )();
    const after = Date.now();

    expect(removed).toBe(2);

    // cutoff is the 3rd arg of listLiveFilesOlderThanForTenant(db, tenantId, cutoff, limit).
    expect(listFilesMock).toHaveBeenCalledOnce();
    const [, tenantId, cutoff] = listFilesMock.mock.calls[0] as [unknown, string, Date, number];
    expect(tenantId).toBe('t1');
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 2 * DAY - 50);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 2 * DAY + 50);

    // best-effort bucket delete per key.
    expect(storageDelete).toHaveBeenCalledTimes(2);
    expect(storageDelete).toHaveBeenCalledWith('k1');
    expect(storageDelete).toHaveBeenCalledWith('k2');

    // soft-delete with the matching ids.
    expect(markDeletedMock).toHaveBeenCalledOnce();
    expect(markDeletedMock.mock.calls[0]?.[1]).toEqual(['f1', 'f2']);
  });

  it('skips a tenant WITHOUT a TTL entirely (eligibility list already filters it out)', async () => {
    // listTenantsWithFileTtl only returns positive-TTL tenants; an empty result
    // models "the only tenant has no TTL" — nothing is listed or deleted.
    listTenantsMock.mockResolvedValue([]);
    const removed = await createFileLifecycleReaperProcessor(runtime({}))();
    expect(removed).toBe(0);
    expect(listFilesMock).not.toHaveBeenCalled();
    expect(markDeletedMock).not.toHaveBeenCalled();
  });

  it('a thrown storage.delete does NOT abort the batch — the rows are still soft-deleted', async () => {
    listTenantsMock.mockResolvedValue([{ tenantId: 't1', ttlDays: 5 }]);
    listFilesMock.mockResolvedValueOnce([
      { id: 'f1', key: 'k1' },
      { id: 'f2', key: 'k2' },
    ]);
    markDeletedMock.mockResolvedValue(2);
    const storageDelete = vi.fn().mockRejectedValue(new Error('bucket down'));

    const removed = await createFileLifecycleReaperProcessor(
      runtime({ storage: { delete: storageDelete } }),
    )();

    expect(removed).toBe(2);
    expect(storageDelete).toHaveBeenCalledTimes(2);
    expect(markDeletedMock).toHaveBeenCalledOnce();
    expect(markDeletedMock.mock.calls[0]?.[1]).toEqual(['f1', 'f2']);
  });

  it('does not bucket-delete when storage is null, but still soft-deletes', async () => {
    listTenantsMock.mockResolvedValue([{ tenantId: 't1', ttlDays: 1 }]);
    listFilesMock.mockResolvedValueOnce([{ id: 'f1', key: 'k1' }]);
    markDeletedMock.mockResolvedValue(1);

    const removed = await createFileLifecycleReaperProcessor(runtime({ storage: null }))();
    expect(removed).toBe(1);
    expect(markDeletedMock).toHaveBeenCalledOnce();
    expect(markDeletedMock.mock.calls[0]?.[1]).toEqual(['f1']);
  });
});
