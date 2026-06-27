import { type AdapterRegistry, createDefaultRegistry } from '@actionow/adapters';
import type { HttpClient, StorageProvider } from '@actionow/contracts';
import { appendAuditLog, createDb, type Database, resolveSecretRef } from '@actionow/db';
import type { BreakerStore, FetchBytes, PutBytes } from '@actionow/engine';
import { buildBreakerStore, registerEngineAdapters, SettingsResolver } from '@actionow/engine';
import {
  type AppEnv,
  createHttpClient,
  createRedis,
  createS3StorageProvider,
  fetchBytesWithTimeout,
  loadEnv,
  putBytesWithTimeout,
  storageConfigFromEnv,
} from '@actionow/infra';

/**
 * The shared runtime the worker processors close over: one drizzle `Database`,
 * the engine's default adapter registry, an `HttpClient`, the parsed env, and
 * the stub secret resolver. Built once at boot in `main.ts` and threaded into
 * each processor factory so the processors stay pure (and unit-testable with a
 * fake runtime).
 */
export interface WorkerRuntime {
  env: AppEnv;
  db: Database;
  adapters: AdapterRegistry;
  http: HttpClient;
  resolveSecret: (ref: string) => Promise<string | undefined>;
  /** The R2/S3 storage provider for media persistence; `null` when unconfigured. */
  storage: StorageProvider | null;
  /** Public custom-domain base persisted media URLs are rewritten to; undefined → no rewrite. */
  publicBaseUrl: string | undefined;
  /**
   * Download upstream media bytes (binary). Defaults to a global-`fetch` impl
   * bounded by an `AbortSignal.timeout` so a hung CDN can't stall settle. Overridable
   * in tests so the network-free suite injects bytes directly.
   */
  fetchBytes: FetchBytes;
  /** Upload bytes to a presigned PUT URL. Defaults to a global-`fetch` impl. */
  putBytes: PutBytes;
  /**
   * The per-`(channel, model)` circuit breaker (弹性2.0) for the async/media
   * submit path (`JobRunner.submit`): excludes Open channels + trial-gates
   * HalfOpen ones, and feeds each submit outcome to the FSM. Every transition is
   * mirrored into the `audit_log` via `appendAuditLog` (the worker has no Nest
   * DI / `AuditService`). Fail-open / best-effort, so it only OPTIMIZES routing.
   */
  breaker: BreakerStore;
  /**
   * Resolves dynamic platform settings (动态配置) — the worker's async/media
   * RELAY_TRACE toggle + byte cap, read per-job. Optional so a fake test runtime
   * can omit it (falls back to env, today's behavior).
   */
  settings?: SettingsResolver;
}

/** Build the production worker runtime from the environment. */
export function createWorkerRuntime(): WorkerRuntime {
  const env = loadEnv();
  const cfg = storageConfigFromEnv(env);
  const storage = cfg === null ? null : createS3StorageProvider(cfg);
  const db = createDb(env.DATABASE_URL);
  // The async/media breaker (弹性2.0): a dedicated Redis client (window + half-
  // open trial gate) + the PG FSM state, with each transition audited via
  // `appendAuditLog` (best-effort; the worker has no AuditService). Fail-open, so
  // a Redis/PG outage only stops the routing OPTIMIZATION, never a job.
  const breaker = buildBreakerStore(db, createRedis(env.REDIS_URL), (input) => {
    void appendAuditLog(db, input).catch(() => {
      // Best-effort: a breaker audit-write failure must never affect a job.
    });
  });
  return {
    env,
    db,
    adapters: registerEngineAdapters(createDefaultRegistry()),
    http: createHttpClient(),
    // A channel's `credential_ref` is a `secret_ref` uuid: the resolver
    // dereferences that row → `SECRET_<locator>`/`<locator>` for `provider=env`
    // (Phase-5 vault deref returns undefined). A non-uuid ref (e.g. the literal
    // `upstream_proxy` proxy locator) reads `SECRET_<ref>`/`<ref>` directly.
    // Shared with the api `SecretResolver` via `resolveSecretRef`. Never logged.
    resolveSecret: (ref: string): Promise<string | undefined> => resolveSecretRef(db, ref),
    storage,
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    fetchBytes: fetchBytesWithTimeout,
    putBytes: putBytesWithTimeout,
    breaker,
    settings: new SettingsResolver({ db, env }),
  };
}
