// packages/engine/src/gateway/persist.ts
//
// model-supply-greenfield 批次4 slice5 — THE §7.5 persist hook implementation
// (slice2/slice4 wired the seam on all three settle paths; this fills it):
//
//   §7.5 转存先于 succeeded — settleGatewayResult invokes this hook BEFORE the
//        settle transaction; media assets are copied off the transient
//        upstream URL into platform storage and the delivered output is
//        rewritten. Failure verdicts stay the SEAM's business: this hook
//        answers {ok:false} and settle-task.ts maps it to fail-no-charge
//        (requirePersist) or 降级交付 + warnings + 告警.
//   §9.4 产物双轨 — mode resolution: request-level override (already stamped
//        on the task row / threaded via the artifact hint, CONSTRAINED by the
//        tenant policy: public denied ⇒ degrade to signed + warning, never
//        silently honored) → model default → 'signed'. signed = presigned GET
//        + artifact_expires_at = now + retention_days (model → platform
//        dynamic-config default → 30d code default); public = stable
//        `${publicBaseUrl}/${key}` + sha256 checksum + lifecycle objects.
//   §9.4 字节路径 — retrieval rides the injected MediaTransfer (infra's
//        streaming pipe: SSRF assertEgressAllowed BEFORE any byte, no
//        full-buffering of known-length bodies, size-tiered timeouts).
//   §7.5 转存重试 — each asset transfer retries with exponential backoff
//        (default 3 attempts); only after exhaustion does the hook answer
//        {ok:false}.
//
// The engine stays infra-free (§14.5 boundary): storage/transfer/queries are
// injected; production wiring lives in the api gateway module and the worker
// runtime.
import { randomUUID } from 'node:crypto';

import type {
  ArtifactMode,
  Asset,
  GatewayError,
  GatewayWarning,
  MediaResult,
  StorageProvider,
} from '@actionow/contracts';
import type { DbOrTx, SupplyModelRow } from '@actionow/db';
import { getSupplyModelById, getTenantArtifactPublicAllowed } from '@actionow/db';

import { mediaExtensionOf } from '../media-result.js';
import type {
  PersistArtifactRecord,
  PersistedArtifactObject,
  PersistHook,
  PersistOutcome,
} from './settle-task.js';

// --- defaults ----------------------------------------------------------------------

/** §9.4 signed-track retention code default (mirrors infra SETTINGS_REGISTRY). */
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
/** §7.5 转存重试: total attempts per asset (1 initial + 2 retries). */
export const DEFAULT_PERSIST_MAX_ATTEMPTS = 3;
/** Exponential backoff base between attempts (250 → 500 → 1000ms …). */
export const DEFAULT_PERSIST_BACKOFF_MS = 250;
/**
 * SigV4 presign ceiling (7 days): a signed GET can never outlive this, so the
 * DELIVERED signed URL is capped here while `artifact_expires_at` carries the
 * full retention (readers re-sign via the task view / a later read API).
 */
export const MAX_SIGNED_URL_SECONDS = 604_800;

const MS_PER_DAY = 86_400_000;

// --- injected transfer (infra createMediaTransfer, structural — §14.5) ---------------

/** What the source's response headers revealed — the presign callback's input. */
export interface MediaTransferSourceInfo {
  contentType?: string | undefined;
  contentLength?: number | undefined;
}

/** Where to PUT: the presigned URL + the content-type it was signed with. */
export interface MediaTransferTarget {
  url: string;
  contentType?: string | undefined;
}

/**
 * The hardened byte mover (infra `createMediaTransfer` satisfies this
 * structurally — SSRF 前置 + streaming pipe + tiered timeouts live THERE).
 */
export interface MediaTransfer {
  /** Stream one UNTRUSTED upstream URL into a presigned PUT; returns size + sha256. */
  fromUrl(
    sourceUrl: string,
    putUrlFor: (info: MediaTransferSourceInfo) => Promise<MediaTransferTarget>,
  ): Promise<{ bytes: number; contentType?: string | undefined; sha256: string }>;
  /** Upload in-memory bytes (b64-decoded inline assets) to a presigned PUT. */
  fromBytes(
    putUrl: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<{ bytes: number; sha256: string }>;
}

// --- deps ---------------------------------------------------------------------------

/** The db reads the hook performs (injectable for unit tests). */
export interface PersistHookQueries {
  getSupplyModelById: typeof getSupplyModelById;
  getTenantArtifactPublicAllowed: typeof getTenantArtifactPublicAllowed;
}

export interface PersistHookDeps {
  db: DbOrTx;
  /** Platform object storage; `null` (unconfigured) ⇒ every media persist FAILS the hook. */
  storage: StorageProvider | null;
  /** The stable public base (STORAGE_PUBLIC_BASE_URL) — the §9.4 public track needs it. */
  publicBaseUrl?: string | undefined;
  /** The hardened byte mover (infra createMediaTransfer in production). */
  transfer: MediaTransfer;
  queries?: Partial<PersistHookQueries> | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  maxAttempts?: number | undefined;
  backoffBaseMs?: number | undefined;
  /** Platform default retention (dynamic config ARTIFACT_RETENTION_DAYS); absent → 30d. */
  resolveDefaultRetentionDays?: (() => Promise<number | undefined>) | undefined;
  /** §9.4 policy-degrade 告警 (public denied → signed); default console.warn. */
  alert?: ((message: string, context?: Record<string, unknown>) => void) | undefined;
  /** Key namespace for ROW-LESS settles (keyless sync paths); default crypto.randomUUID. */
  randomId?: (() => string) | undefined;
}

function queriesOf(deps: PersistHookDeps): PersistHookQueries {
  return {
    getSupplyModelById: deps.queries?.getSupplyModelById ?? getSupplyModelById,
    getTenantArtifactPublicAllowed:
      deps.queries?.getTenantArtifactPublicAllowed ?? getTenantArtifactPublicAllowed,
  };
}

// --- media extraction ------------------------------------------------------------------

/**
 * Read the canonical {@link MediaResult} out of a gateway output, if it IS
 * one. Non-media outputs (chat/embeddings/rerank …) answer `undefined` — the
 * hook no-ops on them (nothing to persist; `requirePersist` is vacuous).
 */
export function mediaResultOf(output: unknown): MediaResult | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const rec = output as Record<string, unknown>;
  if (rec.kind !== 'media' || !Array.isArray(rec.assets)) return undefined;
  return output as MediaResult;
}

// --- errors ------------------------------------------------------------------------------

function persistError(message: string): GatewayError {
  return {
    code: 'internal_error',
    message: `§7.5 artifact persistence failed: ${message}`,
    retryable: false,
    failover: false,
    details: { persist: true },
  };
}

// --- the hook ------------------------------------------------------------------------------

/**
 * Build the production §7.5 {@link PersistHook}. See the module header for
 * the red lines; the flow per invocation is:
 *
 * 1. Non-media output → `{ok: true}` (vacuous — nothing to persist).
 * 2. Resolve the §9.4 track: hint.mode (request override / task stamp) →
 *    model default → 'signed'; a `public` verdict is validated against the
 *    tenant policy (denied ⇒ degrade to signed + warning + 告警) and the
 *    platform's public-base config (absent ⇒ same degrade).
 * 3. Copy EVERY asset into storage under `{tenantId}/{taskId}[-i].{ext}` with
 *    per-asset retry/backoff; rewrite each to its track URL (signed GET /
 *    stable public URL), recording {key, sha256, bytes} lifecycle objects.
 * 4. Answer `{ok: true, output, artifact}` — or `{ok: false}` after retry
 *    exhaustion / zero-asset media / unconfigured storage (the SEAM maps that
 *    to fail-no-charge under requirePersist, else 降级交付).
 */
export function createPersistHook(deps: PersistHookDeps): PersistHook {
  const queries = queriesOf(deps);
  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? DEFAULT_PERSIST_MAX_ATTEMPTS;
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_PERSIST_BACKOFF_MS;
  const randomId = deps.randomId ?? randomUUID;
  const alert = deps.alert ?? console.warn;

  return async (input): Promise<PersistOutcome> => {
    try {
      const media = mediaResultOf(input.output);
      if (media === undefined) return { ok: true }; // non-media settle — nothing to persist
      if (media.assets.length === 0) {
        // The persistMediaResult precedent: a media result WITHOUT assets has
        // nothing durable to deliver — a failure verdict, so requirePersist
        // callers fail (no charge) instead of "succeeding" with nothing.
        return { ok: false, error: persistError('media result has no assets to persist') };
      }

      const tenantId = input.tenantId ?? input.task?.tenantId;
      const warnings: GatewayWarning[] = [];

      // ── §9.4 track resolution: hint (request override / re-stamped row) →
      //    task row stamp → model default → signed. The model row is fetched
      //    lazily — only when something is actually missing. ────────────────
      let model: SupplyModelRow | undefined;
      const needModel =
        (input.artifact?.mode ?? input.task?.artifactMode) == null ||
        input.artifact?.retentionDays === undefined;
      if (needModel && input.task?.modelId != null) {
        model = await queries.getSupplyModelById(deps.db, input.task.modelId);
      }
      let mode: ArtifactMode =
        input.artifact?.mode ??
        (input.task?.artifactMode as ArtifactMode | null | undefined) ??
        model?.artifact.mode ??
        'signed';

      // ── §9.4 tenant policy: public 受租户策略约束 — denied ⇒ degrade to
      //    signed (never silently honored; never a fail — the work is done). ─
      if (mode === 'public') {
        const allowed =
          tenantId !== undefined
            ? await queries.getTenantArtifactPublicAllowed(deps.db, tenantId)
            : false;
        if (!allowed) {
          mode = 'signed';
          warnings.push({
            code: 'artifact_public_denied',
            message:
              'tenant policy disallows public artifacts — degraded to the signed track (§9.4)',
          });
          alert('§9.4 public artifact track denied by tenant policy — degraded to signed', {
            tenantId,
            taskId: input.task?.id,
          });
        } else if (deps.publicBaseUrl === undefined) {
          mode = 'signed';
          warnings.push({
            code: 'artifact_public_unavailable',
            message:
              'platform has no stable public base URL configured — degraded to the signed track',
          });
        }
      }

      const storage = deps.storage;
      if (storage === null) {
        return { ok: false, error: persistError('object storage is not configured') };
      }

      // ── signed-track retention: hint → model → platform default → 30d. ────
      let retentionDays = input.artifact?.retentionDays ?? model?.artifact.retention_days ?? null;
      if (mode === 'signed' && retentionDays == null) {
        retentionDays =
          (await deps.resolveDefaultRetentionDays?.()) ?? DEFAULT_ARTIFACT_RETENTION_DAYS;
      }

      // ── per-asset copy with §7.5 retry/backoff. All-or-nothing: ONE asset
      //    exhausting its retries fails the whole persist (mixed platform/
      //    upstream outputs are worse than an honest degrade). ───────────────
      const keyBase = `${tenantId ?? 'platform'}/${input.task?.id ?? randomId()}`;
      const single = media.assets.length === 1;
      const objects: PersistedArtifactObject[] = [];
      const rewritten: Asset[] = [];
      const signedGetSeconds =
        mode === 'signed'
          ? Math.min(
              (retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS) * 86_400,
              MAX_SIGNED_URL_SECONDS,
            )
          : 0;

      for (let i = 0; i < media.assets.length; i += 1) {
        const asset = media.assets[i];
        if (asset === undefined) continue;
        const ext = mediaExtensionOf(asset.url, asset.mime);
        const key = single ? `${keyBase}.${ext}` : `${keyBase}-${String(i)}.${ext}`;

        const stored = await withRetry(
          () => persistOneAsset(storage, deps.transfer, asset, key),
          maxAttempts,
          backoffBaseMs,
          sleep,
        );

        const url =
          mode === 'public'
            ? `${deps.publicBaseUrl ?? ''}/${key}`
            : (await storage.presignGet(key, { expiresIn: signedGetSeconds })).url;

        const contentType = stored.contentType ?? asset.mime;
        const next: Asset = {
          ...asset,
          url,
          mime: contentType,
          size: stored.bytes,
          // §9.4 checksum rides the asset too (etag = hex sha256), both tracks.
          etag: stored.sha256,
        };
        delete next.b64; // durable URL replaces inline bytes (never re-deliver b64)
        rewritten.push(next);
        // Asset.mime is contract-required, so contentType is always present.
        objects.push({ key, sha256: stored.sha256, bytes: stored.bytes, contentType });
      }

      const artifact: PersistArtifactRecord = {
        mode,
        expiresAt:
          mode === 'signed'
            ? new Date(
                now().getTime() + (retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS) * MS_PER_DAY,
              )
            : null, // public 轨: 豁免清理 — no expiry, checksum + objects retained
        objects,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      return { ok: true, output: { ...media, assets: rewritten }, artifact };
    } catch (err) {
      return {
        ok: false,
        error: persistError(err instanceof Error ? err.message : String(err)),
      };
    }
  };
}

// --- helpers -----------------------------------------------------------------------------

interface StoredAsset {
  bytes: number;
  sha256: string;
  contentType?: string | undefined;
}

/** Copy ONE asset (URL-fetched via the hardened transfer, or b64-decoded) under `key`. */
async function persistOneAsset(
  storage: StorageProvider,
  transfer: MediaTransfer,
  asset: Asset,
  key: string,
): Promise<StoredAsset> {
  if (asset.url !== undefined) {
    // The presign happens AFTER the source headers arrive (a presigned PUT is
    // content-type-bound); SSRF + streaming + tiered timeouts live in the
    // injected transfer (infra).
    return transfer.fromUrl(asset.url, async (info) => {
      const contentType = info.contentType ?? asset.mime;
      const presign = await storage.presignPut(key, { contentType });
      return { url: presign.url, contentType };
    });
  }
  if (asset.b64 !== undefined) {
    const bytes = new Uint8Array(Buffer.from(asset.b64, 'base64'));
    const presign = await storage.presignPut(key, { contentType: asset.mime });
    const r = await transfer.fromBytes(presign.url, bytes, asset.mime);
    return { ...r, contentType: asset.mime };
  }
  throw new Error('asset has neither url nor b64');
}

/** §7.5 转存重试: run `fn` up to `maxAttempts` times with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  backoffBaseMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await sleep(backoffBaseMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
