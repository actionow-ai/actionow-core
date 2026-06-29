import { z } from 'zod';

/**
 * Single source of truth for the platform-auth **session** wire contracts
 * (auth-sessions slice): the additive login/register token pair, the
 * refresh/logout request bodies, and the public JWKS response. Same contract-first
 * pattern as the other `*-requests.ts` files — the backend validates request
 * bodies against these and the frontend imports the inferred TYPE only.
 */

/**
 * The ADDITIVE register/login/refresh response. `token` is RETAINED (and always
 * equals `accessToken`) so existing clients/tests/apps-web keep working unchanged;
 * `refreshToken` + `expiresIn` are the new fields powering refresh-token rotation.
 */
export const tokenPairSchema = z.object({
  /** Back-compat alias of `accessToken`. */
  token: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** The access-token TTL string (e.g. `12h`). */
  expiresIn: z.string(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/** `POST /auth/refresh` — rotate a refresh token for a fresh access + refresh pair. */
export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequestBody = z.infer<typeof refreshRequestSchema>;

/** `POST /auth/logout` — revoke the session behind a refresh token. */
export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequestBody = z.infer<typeof logoutRequestSchema>;

/**
 * `GET /.well-known/jwks.json` — the public JWK set used to verify RS256 access
 * tokens. A `keys` ARRAY (so multi-`kid` rotation stays non-breaking); empty under
 * the default HS256 config. Each JWK is loosely typed (a passthrough record) since
 * the field set varies by key type.
 */
export const jwksResponseSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});
export type JwksResponse = z.infer<typeof jwksResponseSchema>;
