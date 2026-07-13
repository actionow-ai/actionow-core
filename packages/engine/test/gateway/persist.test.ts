// 批次4 slice5 — the §7.5 persist hook + §9.4 产物双轨 red lines:
//   转存先于 succeeded (the transfer strictly precedes the settle write);
//   require_persist=true 失败即 fail 不扣费; require_persist=false 降级 =
//   上游 URL + warnings + 告警 (never a fail); 转存重试退避; signed 轨带
//   expires_at + presigned GET, public 轨带 checksum + 稳定 URL + null expiry
//   (豁免清理); 请求级 artifactMode 覆盖受租户策略约束 (denied ⇒ degrade to
//   signed + warning, never silently honored).
import type { StorageProvider } from '@actionow/contracts';
import type { SupplyModelRow } from '@actionow/db';
import { describe, expect, it, vi } from 'vitest';

import {
  createPersistHook,
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  type GatewaySettleDeps,
  MAX_SIGNED_URL_SECONDS,
  mediaResultOf,
  type MediaTransfer,
  type PersistHookDeps,
  settleGatewayResult,
} from '../../src/index.js';
import {
  costCardRow,
  fakeReservation,
  fakeSettleStore,
  fakeTaskStore,
  modelRow,
  POISONED_DB,
  saleCardRow,
  taskRowOf,
} from './gateway-fixtures.js';

const NOW = new Date('2026-07-12T00:00:00.000Z');
const DAY_MS = 86_400_000;
const SHA_URL = 'a'.repeat(64);
const SHA_B64 = 'b'.repeat(64);

// --- fakes -----------------------------------------------------------------------------

function fakeStorage(log: string[] = []): StorageProvider {
  return {
    kind: 'r2',
    presignPut: (key, opts) => {
      log.push(`presignPut:${key}:${opts?.contentType ?? ''}`);
      return Promise.resolve({ url: `https://storage.local/put/${key}`, key, expiresIn: 900 });
    },
    presignGet: (key, opts) => {
      log.push(`presignGet:${key}:${String(opts?.expiresIn ?? 0)}`);
      return Promise.resolve({
        url: `https://storage.local/signed/${key}?exp=${String(opts?.expiresIn ?? 0)}`,
        expiresIn: opts?.expiresIn ?? 3600,
      });
    },
    head: () => Promise.resolve({ exists: false }),
    delete: () => Promise.resolve(),
  };
}

interface FakeTransfer extends MediaTransfer {
  urlCalls: string[];
  byteCalls: { putUrl: string; bytes: number; contentType?: string | undefined }[];
  log: string[];
}

/** A recording MediaTransfer; the first `failures` fromUrl attempts throw (§7.5 retry). */
function fakeTransfer(o: { failures?: number; log?: string[] } = {}): FakeTransfer {
  let failures = o.failures ?? 0;
  const log = o.log ?? [];
  const urlCalls: string[] = [];
  const byteCalls: FakeTransfer['byteCalls'] = [];
  return {
    urlCalls,
    byteCalls,
    log,
    async fromUrl(
      sourceUrl,
      putUrlFor,
    ): Promise<{
      bytes: number;
      contentType?: string | undefined;
      sha256: string;
    }> {
      urlCalls.push(sourceUrl);
      if (failures > 0) {
        failures -= 1;
        throw new Error('upstream transfer boom');
      }
      const target = await putUrlFor({ contentType: 'image/png', contentLength: 3 });
      log.push(`transfer:${target.url}`);
      return { bytes: 3, contentType: target.contentType, sha256: SHA_URL };
    },
    fromBytes(putUrl, bytes, contentType): Promise<{ bytes: number; sha256: string }> {
      byteCalls.push({ putUrl, bytes: bytes.byteLength, contentType });
      log.push(`transfer:${putUrl}`);
      return Promise.resolve({ bytes: bytes.byteLength, sha256: SHA_B64 });
    },
  };
}

function artifactModel(o: {
  mode?: 'signed' | 'public';
  retentionDays?: number | null;
}): SupplyModelRow {
  const model = modelRow();
  return {
    ...model,
    artifact: { mode: o.mode ?? 'signed', retention_days: o.retentionDays ?? null },
  };
}

interface HookHarness {
  deps: PersistHookDeps;
  transfer: FakeTransfer;
  storageLog: string[];
  sleeps: number[];
  alerts: string[];
  publicAllowed: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
}

function harness(
  o: {
    storage?: StorageProvider | null;
    transfer?: FakeTransfer;
    publicBaseUrl?: string | undefined;
    publicAllowed?: boolean;
    model?: SupplyModelRow;
    resolveDefaultRetentionDays?: (() => Promise<number | undefined>) | undefined;
  } = {},
): HookHarness {
  const storageLog: string[] = [];
  const sleeps: number[] = [];
  const alerts: string[] = [];
  const transfer = o.transfer ?? fakeTransfer();
  const publicAllowed = vi.fn().mockResolvedValue(o.publicAllowed ?? true);
  const getModel = vi.fn().mockResolvedValue(o.model ?? artifactModel({}));
  const deps: PersistHookDeps = {
    db: POISONED_DB,
    storage: o.storage === undefined ? fakeStorage(storageLog) : o.storage,
    publicBaseUrl: o.publicBaseUrl,
    transfer,
    queries: {
      getSupplyModelById: getModel as never,
      getTenantArtifactPublicAllowed: publicAllowed as never,
    },
    now: () => NOW,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    alert: (message) => {
      alerts.push(message);
    },
    randomId: () => 'rand-1',
  };
  return { deps, transfer, storageLog, sleeps, alerts, publicAllowed, getModel };
}

const URL_ASSET = {
  role: 'primary' as const,
  modality: 'image' as const,
  url: 'https://upstream.example.com/tmp/a.png',
  mime: 'image/png',
};

function mediaOut(assets: unknown[]): unknown {
  return { kind: 'media', assets, usage: { images: assets.length } };
}

const USAGE = { metrics: { images: 1 }, billingDims: {}, estimated: false };

// --- mediaResultOf ------------------------------------------------------------------------

describe('mediaResultOf', () => {
  it('extracts a canonical MediaResult and rejects everything else', () => {
    expect(mediaResultOf(mediaOut([URL_ASSET]))).toBeDefined();
    expect(mediaResultOf({ text: 'hello' })).toBeUndefined();
    expect(mediaResultOf('media')).toBeUndefined();
    expect(mediaResultOf(null)).toBeUndefined();
    expect(mediaResultOf({ kind: 'media', assets: 'nope' })).toBeUndefined();
  });
});

// --- the hook: 双轨 -------------------------------------------------------------------------

describe('createPersistHook — §9.4 双轨', () => {
  it('non-media output → vacuous ok (no transfer, no storage)', async () => {
    const h = harness();
    const out = await createPersistHook(h.deps)({
      output: { text: 'chat answer' },
      usage: USAGE,
      tenantId: 'tenant-1',
    });
    expect(out).toEqual({ ok: true });
    expect(h.transfer.urlCalls).toEqual([]);
    expect(h.storageLog).toEqual([]);
  });

  it('signed (default): rewrites to a presigned GET, stamps expiresAt = now + 30d default, records checksum objects', async () => {
    const h = harness();
    const task = taskRowOf({ id: 'task-s', tenantId: 'tenant-1', artifactMode: null });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task,
      tenantId: 'tenant-1',
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact?.mode).toBe('signed');
    expect(out.artifact?.expiresAt?.getTime()).toBe(
      NOW.getTime() + DEFAULT_ARTIFACT_RETENTION_DAYS * DAY_MS,
    );
    // The signed GET lifetime is capped at the SigV4 ceiling (30d retention > 7d cap).
    expect(h.storageLog).toContain(
      `presignGet:tenant-1/task-s.png:${String(MAX_SIGNED_URL_SECONDS)}`,
    );
    const media = out.output as { assets: { url: string; etag?: string; size?: number }[] };
    expect(media.assets[0]?.url).toBe(
      `https://storage.local/signed/tenant-1/task-s.png?exp=${String(MAX_SIGNED_URL_SECONDS)}`,
    );
    expect(media.assets[0]?.etag).toBe(SHA_URL);
    expect(out.artifact?.objects).toEqual([
      { key: 'tenant-1/task-s.png', sha256: SHA_URL, bytes: 3, contentType: 'image/png' },
    ]);
  });

  it('public: stable publicBaseUrl URL + sha256 checksum + NULL expiry (豁免清理)', async () => {
    const h = harness({ publicBaseUrl: 'https://asset.local' });
    const task = taskRowOf({ id: 'task-p', tenantId: 'tenant-1' });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task,
      tenantId: 'tenant-1',
      artifact: { mode: 'public' },
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact?.mode).toBe('public');
    expect(out.artifact?.expiresAt).toBeNull();
    const media = out.output as { assets: { url: string; etag?: string }[] };
    expect(media.assets[0]?.url).toBe('https://asset.local/tenant-1/task-p.png');
    expect(media.assets[0]?.etag).toBe(SHA_URL);
    expect(out.artifact?.objects[0]?.sha256).toBe(SHA_URL);
    expect(h.publicAllowed).toHaveBeenCalledWith(expect.anything(), 'tenant-1');
  });

  it('§9.4 tenant policy: public requested but DENIED → degraded to signed + warning + 告警 (never silently honored, never a fail)', async () => {
    const h = harness({ publicBaseUrl: 'https://asset.local', publicAllowed: false });
    const task = taskRowOf({ id: 'task-d', tenantId: 'tenant-1' });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task,
      tenantId: 'tenant-1',
      artifact: { mode: 'public' }, // the request-level override
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact?.mode).toBe('signed');
    expect(out.artifact?.expiresAt).not.toBeNull();
    expect(out.artifact?.warnings?.map((w) => w.code)).toEqual(['artifact_public_denied']);
    expect(h.alerts).toHaveLength(1);
    const media = out.output as { assets: { url: string }[] };
    expect(media.assets[0]?.url).toContain('https://storage.local/signed/');
  });

  it('public without a configured publicBaseUrl → degraded to signed + warning', async () => {
    const h = harness({ publicBaseUrl: undefined });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task: taskRowOf({ tenantId: 'tenant-1' }),
      tenantId: 'tenant-1',
      artifact: { mode: 'public' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact?.mode).toBe('signed');
    expect(out.artifact?.warnings?.map((w) => w.code)).toEqual(['artifact_public_unavailable']);
  });

  it('retention ladder: hint → model.artifact.retention_days → platform dynamic default → 30d code default', async () => {
    // 1. hint wins.
    const h1 = harness();
    const o1 = await createPersistHook(h1.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task: taskRowOf({ id: 't1', tenantId: 'tenant-1' }),
      tenantId: 'tenant-1',
      artifact: { mode: 'signed', retentionDays: 1 },
    });
    if (!o1.ok) throw new Error('expected ok');
    expect(o1.artifact?.expiresAt?.getTime()).toBe(NOW.getTime() + 1 * DAY_MS);
    expect(h1.storageLog.some((l) => l.endsWith(':86400'))).toBe(true); // 1d < the 7d cap

    // 2. model declaration (hook re-fetches the model by task.modelId).
    const h2 = harness({ model: artifactModel({ retentionDays: 2 }) });
    const o2 = await createPersistHook(h2.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task: taskRowOf({ id: 't2', tenantId: 'tenant-1', modelId: 'model-1' }),
      tenantId: 'tenant-1',
      artifact: { mode: 'signed' }, // retention deliberately absent (worker reconstruction)
    });
    if (!o2.ok) throw new Error('expected ok');
    expect(h2.getModel).toHaveBeenCalledWith(expect.anything(), 'model-1');
    expect(o2.artifact?.expiresAt?.getTime()).toBe(NOW.getTime() + 2 * DAY_MS);

    // 3. platform dynamic-config default (model declares none).
    const h3 = harness({
      model: artifactModel({ retentionDays: null }),
      resolveDefaultRetentionDays: () => Promise.resolve(5),
    });
    h3.deps.resolveDefaultRetentionDays = (): Promise<number | undefined> => Promise.resolve(5);
    const o3 = await createPersistHook(h3.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task: taskRowOf({ id: 't3', tenantId: 'tenant-1', modelId: 'model-1' }),
      tenantId: 'tenant-1',
      artifact: { mode: 'signed' },
    });
    if (!o3.ok) throw new Error('expected ok');
    expect(o3.artifact?.expiresAt?.getTime()).toBe(NOW.getTime() + 5 * DAY_MS);
  });

  it('multi-asset: one object per asset under -i keys; b64 assets upload via fromBytes and DROP the b64', async () => {
    const h = harness();
    const b64Asset = {
      role: 'primary' as const,
      modality: 'image' as const,
      b64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mime: 'image/webp',
    };
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET, b64Asset]),
      usage: USAGE,
      task: taskRowOf({ id: 'task-m', tenantId: 'tenant-1' }),
      tenantId: 'tenant-1',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact?.objects.map((o) => o.key)).toEqual([
      'tenant-1/task-m-0.png',
      'tenant-1/task-m-1.webp',
    ]);
    expect(h.transfer.byteCalls).toEqual([
      {
        putUrl: 'https://storage.local/put/tenant-1/task-m-1.webp',
        bytes: 4,
        contentType: 'image/webp',
      },
    ]);
    const media = out.output as { assets: { b64?: string; url?: string }[] };
    expect(media.assets[1]?.b64).toBeUndefined();
    expect(media.assets[1]?.url).toContain('tenant-1/task-m-1.webp');
  });

  it('row-less settle (keyless sync) keys under the injected random id', async () => {
    const h = harness();
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      tenantId: 'tenant-1',
      artifact: { mode: 'signed', retentionDays: 1 },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact?.objects[0]?.key).toBe('tenant-1/rand-1.png');
  });
});

// --- the hook: 重试 + failure verdicts --------------------------------------------------------

describe('createPersistHook — §7.5 转存重试 + failure verdicts', () => {
  it('retries with exponential backoff and succeeds within the attempt budget', async () => {
    const h = harness({ transfer: fakeTransfer({ failures: 2 }) });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task: taskRowOf({ tenantId: 'tenant-1' }),
      tenantId: 'tenant-1',
    });
    expect(out.ok).toBe(true);
    expect(h.transfer.urlCalls).toHaveLength(3); // 2 failures + 1 success
    expect(h.sleeps).toEqual([250, 500]); // exponential backoff between attempts
  });

  it('exhausted retries → {ok:false} (the seam maps it to fail-no-charge / 降级)', async () => {
    const h = harness({ transfer: fakeTransfer({ failures: 3 }) });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      task: taskRowOf({ tenantId: 'tenant-1' }),
      tenantId: 'tenant-1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('internal_error');
    expect(out.error.message).toContain('artifact persistence failed');
    expect(h.transfer.urlCalls).toHaveLength(3); // the full attempt budget was spent
  });

  it('unconfigured storage → {ok:false} (require_persist stays enforceable)', async () => {
    const h = harness({ storage: null });
    const out = await createPersistHook(h.deps)({
      output: mediaOut([URL_ASSET]),
      usage: USAGE,
      tenantId: 'tenant-1',
    });
    expect(out.ok).toBe(false);
  });

  it('media result with ZERO assets → {ok:false} (nothing durable to deliver)', async () => {
    const h = harness();
    const out = await createPersistHook(h.deps)({
      output: mediaOut([]),
      usage: USAGE,
      tenantId: 'tenant-1',
    });
    expect(out.ok).toBe(false);
  });
});

// --- the seam: 转存先于 succeeded / fail 不扣费 / 降级 -----------------------------------------

describe('settleGatewayResult × createPersistHook (§7.5 seam end-to-end)', () => {
  function seam(o: { transfer?: FakeTransfer; requirePersist?: boolean } = {}): {
    run: (
      over?: Partial<Parameters<typeof settleGatewayResult>[1]>,
    ) => ReturnType<typeof settleGatewayResult>;
    order: string[];
    store: ReturnType<typeof fakeSettleStore>;
    taskStore: ReturnType<typeof fakeTaskStore>;
    task: ReturnType<typeof taskRowOf>;
    alerts: string[];
    reservationLog: string[];
  } {
    const order: string[] = [];
    const taskStore = fakeTaskStore();
    const task = taskRowOf({ status: 'running', tenantId: 'tenant-1' });
    taskStore.tasks.set(task.id, task);
    const store = fakeSettleStore({
      cards: [saleCardRow(), costCardRow()],
      taskStore,
      log: order, // 'settle' lands here in arrival order
    });
    const transfer = o.transfer ?? fakeTransfer({ log: order }); // 'transfer:*' lands here
    const alerts: string[] = [];
    const { reservation, log: reservationLog } = fakeReservation();
    const h = harness({ transfer });
    const persist = createPersistHook(h.deps);
    const deps: GatewaySettleDeps = {
      db: POISONED_DB,
      repo: { ...store.repo, transitionTask: taskStore.repo.transitionTask },
      alert: (message) => {
        alerts.push(message);
      },
    };
    const run = (
      over: Partial<Parameters<typeof settleGatewayResult>[1]> = {},
    ): ReturnType<typeof settleGatewayResult> =>
      settleGatewayResult(deps, {
        tenantId: 'tenant-1',
        accountId: 'acct-1',
        subjectId: null,
        wallet: { kind: 'tenant', accountId: 'acct-1', tenantId: 'tenant-1' },
        holdAmount: 5_000n,
        saleCardRef: { cardId: 'card-sale', version: 3 },
        costCardRef: { cardId: 'card-cost', version: 1 },
        billingDims: {},
        upstreamInputs: {},
        modifiers: [],
        usage: USAGE,
        output: mediaOut([URL_ASSET]),
        offeringId: 'off-1',
        task,
        reservation,
        persist,
        requirePersist: o.requirePersist,
        artifact: { mode: 'signed', retentionDays: 1 },
        ...over,
      });
    return { run, order, store, taskStore, task, alerts, reservationLog };
  }

  it('转存先于 succeeded: the byte transfer strictly PRECEDES the settle write, which stamps mode/expiry/objects', async () => {
    const s = seam();
    const out = await s.run();

    expect(out.ok).toBe(true);
    const transferIdx = s.order.findIndex((e) => e.startsWith('transfer:'));
    const settleIdx = s.order.indexOf('settle');
    expect(transferIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeGreaterThan(transferIdx); // §7.5 red line

    // The settle transaction received the REWRITTEN output + the §9.4 stamp.
    const settled = s.store.settles[0];
    expect(settled?.artifactMode).toBe('signed');
    expect(settled?.artifactExpiresAt?.getTime()).toBe(NOW.getTime() + 1 * DAY_MS);
    expect(settled?.artifactObjects).toEqual([
      expect.objectContaining({ sha256: SHA_URL, bytes: 3 }),
    ]);
    const output = settled?.output as { assets: { url: string }[] };
    expect(output.assets[0]?.url).toContain('https://storage.local/signed/');
  });

  it('require_persist=true + 转存失败 → task failed, hold rolled back, NO settle write (不扣费)', async () => {
    const s = seam({ transfer: fakeTransfer({ failures: 3 }), requirePersist: true });
    const out = await s.run();

    expect(out.ok).toBe(false);
    expect(s.store.settles).toEqual([]); // §7.5 失败即 fail 不扣费
    expect(s.taskStore.tasks.get(s.task.id)?.status).toBe('failed');
    expect(s.reservationLog).toContain('release:full'); // hold rolled back
  });

  it('require_persist=false + 转存失败 → 降级: settles the ORIGINAL upstream output + warnings + 告警, artifact columns untouched', async () => {
    const s = seam({ transfer: fakeTransfer({ failures: 3 }), requirePersist: false });
    const out = await s.run();

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.warnings?.map((w) => w.code)).toEqual(['artifact_persist_degraded']);
    expect(s.alerts).toHaveLength(1); // §7.5 告警
    const settled = s.store.settles[0];
    const output = settled?.output as { assets: { url: string }[] };
    expect(output.assets[0]?.url).toBe(URL_ASSET.url); // the upstream URL delivered
    expect(settled?.artifactMode).toBeUndefined(); // no §9.4 stamp on a degrade
    expect(s.taskStore.tasks.get(s.task.id)?.status).toBe('succeeded');
  });

  it('public 轨 through the seam: stamp mode=public, NULL expiry, checksum objects on the settle', async () => {
    const s = seam();
    const out = await s.run({ artifact: { mode: 'public' } });
    // harness() default: tenant allowed BUT no publicBaseUrl → degrade signed.
    // Re-run via a public-capable harness instead:
    expect(out.ok).toBe(true);

    const order: string[] = [];
    const taskStore = fakeTaskStore();
    const task = taskRowOf({ status: 'running', tenantId: 'tenant-1' });
    taskStore.tasks.set(task.id, task);
    const store = fakeSettleStore({ taskStore, log: order });
    const h = harness({
      publicBaseUrl: 'https://asset.local',
      transfer: fakeTransfer({ log: order }),
    });
    const { reservation } = fakeReservation();
    const out2 = await settleGatewayResult(
      { db: POISONED_DB, repo: { ...store.repo, transitionTask: taskStore.repo.transitionTask } },
      {
        tenantId: 'tenant-1',
        accountId: 'acct-1',
        subjectId: null,
        wallet: { kind: 'tenant', accountId: 'acct-1', tenantId: 'tenant-1' },
        holdAmount: 5_000n,
        saleCardRef: { cardId: 'card-sale', version: 3 },
        costCardRef: null,
        billingDims: {},
        upstreamInputs: {},
        modifiers: [],
        usage: USAGE,
        output: mediaOut([URL_ASSET]),
        offeringId: 'off-1',
        task,
        reservation,
        persist: createPersistHook(h.deps),
        artifact: { mode: 'public' },
      },
    );
    expect(out2.ok).toBe(true);
    const settled = store.settles[0];
    expect(settled?.artifactMode).toBe('public');
    expect(settled?.artifactExpiresAt).toBeNull();
    expect(settled?.artifactObjects).toEqual([expect.objectContaining({ sha256: SHA_URL })]);
    const output = settled?.output as { assets: { url: string }[] };
    expect(output.assets[0]?.url).toBe(`https://asset.local/tenant-1/${task.id}.png`);
  });
});
