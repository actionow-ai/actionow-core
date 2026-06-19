import { SetMetadata } from '@nestjs/common';

/** Reflector metadata key under which {@link Idempotent} marks a route. */
export const IDEMPOTENT_KEY = 'idempotency:enabled';

/**
 * Opt a mutating POST route into `Idempotency-Key` replay (Track D5). A request
 * to a decorated route that carries a non-empty `Idempotency-Key` header has its
 * first successful response captured; a duplicate POST with the SAME key replays
 * that response verbatim instead of re-running the handler (read by the
 * {@link IdempotencyInterceptor}).
 *
 * SECURITY — opt-in by design: the replay store persists the response BODY at
 * rest, so this decorator is applied ONLY to an allowlist of NON-secret-
 * returning admin POSTs. Endpoints that return one-time secrets in their body
 * (`POST /admin/api-keys`, `/secrets`, `/oauth-sessions` + the codex
 * `login/start` + `login/complete` flows, `/redemption-codes`) are deliberately
 * NEVER decorated, so no plaintext secret is ever cached. An undecorated route
 * simply ignores the header (no caching).
 */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, true);
