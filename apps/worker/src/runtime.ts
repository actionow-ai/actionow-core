import { type AdapterRegistry, createDefaultRegistry } from '@actionow/adapters';
import type { HttpClient, StorageProvider } from '@actionow/contracts';
import { createDb, type Database, resolveSecretRef } from '@actionow/db';
import type { FetchBytes, PutBytes } from '@actionow/engine';
import {
  type AppEnv,
  createS3StorageProvider,
  FetchHttpClient,
  loadEnv,
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
}

/** Upper bound (ms) on a single upstream media download before it is aborted. */
const MEDIA_FETCH_TIMEOUT_MS = 30_000;

/**
 * Default {@link FetchBytes}: download an upstream media URL over global `fetch`,
 * bounded by an `AbortSignal.timeout` so a hanging upstream can never stall the
 * settle path (Task 9 review). Returns the raw bytes + content type.
 */
const defaultFetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? undefined;
  return contentType === undefined ? { bytes } : { bytes, contentType };
};

/** Default {@link PutBytes}: upload bytes to a presigned PUT URL over global `fetch`. */
const defaultPutBytes: PutBytes = async (url, bytes, contentType) => {
  await fetch(url, {
    method: 'PUT',
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    body: bytes,
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
};

/** Build the production worker runtime from the environment. */
export function createWorkerRuntime(): WorkerRuntime {
  const env = loadEnv();
  const cfg = storageConfigFromEnv(env);
  const storage = cfg === null ? null : createS3StorageProvider(cfg);
  const db = createDb(env.DATABASE_URL);
  return {
    env,
    db,
    adapters: createDefaultRegistry(),
    http: new FetchHttpClient(),
    // A channel's `credential_ref` is a `secret_ref` uuid: the resolver
    // dereferences that row → `SECRET_<locator>`/`<locator>` for `provider=env`
    // (Phase-5 vault deref returns undefined). A non-uuid ref (e.g. the literal
    // `upstream_proxy` proxy locator) reads `SECRET_<ref>`/`<ref>` directly.
    // Shared with the api `SecretResolver` via `resolveSecretRef`. Never logged.
    resolveSecret: (ref: string): Promise<string | undefined> => resolveSecretRef(db, ref),
    storage,
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    fetchBytes: defaultFetchBytes,
    putBytes: defaultPutBytes,
  };
}
