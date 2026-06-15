import { type AdapterRegistry, createDefaultRegistry } from '@actionow/adapters';
import type { HttpClient } from '@actionow/contracts';
import { createDb, type Database } from '@actionow/db';
import { type AppEnv, FetchHttpClient, loadEnv } from '@actionow/infra';

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
}

/**
 * STUB secret resolver (Phase 3 — vault-backed resolution is Phase 5). Resolves
 * a credential `ref` from `SECRET_<ref>` then `<ref>` in `process.env`. The
 * value is a secret: handed to the adapter context, never logged.
 */
export function resolveSecretFromEnv(ref: string): Promise<string | undefined> {
  const envKey = `SECRET_${ref.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  return Promise.resolve(process.env[envKey] ?? process.env[ref]);
}

/** Build the production worker runtime from the environment. */
export function createWorkerRuntime(): WorkerRuntime {
  const env = loadEnv();
  return {
    env,
    db: createDb(env.DATABASE_URL),
    adapters: createDefaultRegistry(),
    http: new FetchHttpClient(),
    resolveSecret: resolveSecretFromEnv,
  };
}
