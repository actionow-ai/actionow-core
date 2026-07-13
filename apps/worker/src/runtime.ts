import type { HttpClient, StorageProvider } from '@actionow/contracts';
import { createDb, type Database } from '@actionow/db';
import type { MediaTransfer } from '@actionow/engine';
import { SettingsResolver } from '@actionow/engine';
import {
  type AppEnv,
  createHttpClient,
  createMediaTransfer,
  createS3StorageProvider,
  loadEnv,
  storageConfigFromEnv,
} from '@actionow/infra';

/**
 * The shared runtime the worker processors close over: one drizzle `Database`,
 * an `HttpClient`, the parsed env, storage, and the §9.4 byte mover. Built once
 * at boot in `main.ts` and threaded into each processor factory so the
 * processors stay pure (and unit-testable with a fake runtime).
 *
 * 批次6 D2: the legacy job-runner fields (adapters registry, fetchBytes/
 * putBytes, the job-progress publisher, the relay breaker) died with the old
 * execution world — the task-center sweeps carry their own SPI wiring.
 */
export interface WorkerRuntime {
  env: AppEnv;
  db: Database;
  http: HttpClient;
  /** The R2/S3 storage provider for media persistence; `null` when unconfigured. */
  storage: StorageProvider | null;
  /** Public custom-domain base persisted media URLs are rewritten to; undefined → no rewrite. */
  publicBaseUrl: string | undefined;
  /**
   * §9.4 hardened byte mover for the persist hook (批次4 slice5): SSRF-guarded,
   * streaming (禁全量进内存), size-tier timed. Optional so a fake test runtime
   * can inject a recorder; production wires infra's `createMediaTransfer()`.
   */
  mediaTransfer?: MediaTransfer;
  /**
   * Resolves dynamic platform settings (动态配置), read per-sweep. Optional so
   * a fake test runtime can omit it (falls back to env).
   */
  settings?: SettingsResolver;
}

/** Build the production worker runtime from the environment. */
export function createWorkerRuntime(): WorkerRuntime {
  const env = loadEnv();
  const cfg = storageConfigFromEnv(env);
  const storage = cfg === null ? null : createS3StorageProvider(cfg);
  const db = createDb(env.DATABASE_URL);
  return {
    env,
    db,
    http: createHttpClient(),
    storage,
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    mediaTransfer: createMediaTransfer(),
    settings: new SettingsResolver({ db, env }),
  };
}
