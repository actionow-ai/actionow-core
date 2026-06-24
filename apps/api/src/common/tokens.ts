/**
 * DI injection tokens for non-class providers (the drizzle `Database` handle,
 * the parsed env, and the engine's adapter registry). NestJS resolves these by
 * the string token via `@Inject(...)`.
 */
export const DB = Symbol('DB');
export const ENV = Symbol('ENV');
export const ADAPTERS = Symbol('ADAPTERS');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
/** Concurrency (in-flight) limiter for governance `concurrency` rules. */
export const CONCURRENCY_LIMITER = Symbol('CONCURRENCY_LIMITER');
/**
 * The default S3-compatible {@link StorageProvider} built from `STORAGE_*` env.
 * `null` when storage is unconfigured (the API still boots); the `/v1/files`
 * service guards usage and fails with `invalid_input` in that case.
 */
export const STORAGE = Symbol('STORAGE');
/**
 * The set of `provider/name` Dify model keys that already have a gateway
 * mapping, consumed by the dify-import compat report. Defaults to an empty set
 * (an unknown model is a non-blocking `warn`); overridable per deployment/test.
 */
export const KNOWN_MODELS = Symbol('KNOWN_MODELS');
/**
 * The engine `PaymentService`, constructed over a `PaymentRegistry` built from
 * whatever payment-provider creds are present in env. Overridable in tests so
 * the webhook e2e injects a fake provider (no real Stripe network call).
 */
export const PAYMENTS = Symbol('PAYMENTS');
/**
 * The shared {@link HttpClient} for server-side upstream calls (e.g. the codex
 * OAuth code-exchange). Defaults to a real `FetchHttpClient`; overridable in
 * tests so the OAuth-login e2e injects a fake (no real network call).
 */
export const HTTP = Symbol('HTTP');
