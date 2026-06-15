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
/**
 * The set of `provider/name` Dify model keys that already have a gateway
 * mapping, consumed by the dify-import compat report. Defaults to an empty set
 * (an unknown model is a non-blocking `warn`); overridable per deployment/test.
 */
export const KNOWN_MODELS = Symbol('KNOWN_MODELS');
