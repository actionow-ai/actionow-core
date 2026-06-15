/**
 * DI injection tokens for non-class providers (the drizzle `Database` handle,
 * the parsed env, and the engine's adapter registry). NestJS resolves these by
 * the string token via `@Inject(...)`.
 */
export const DB = Symbol('DB');
export const ENV = Symbol('ENV');
export const ADAPTERS = Symbol('ADAPTERS');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
