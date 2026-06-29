/**
 * DI token for the resolved RS256 key material (`Rs256Keys | null`), loaded ONCE
 * from env at module init by {@link AuthCryptoModule}. `null` means no RS256 key
 * is configured — the HS256 path stays active and the JWKS is empty.
 */
export const JWT_KEYS = Symbol('JWT_KEYS');
