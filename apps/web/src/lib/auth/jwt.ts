export interface JwtClaims {
  sub: string;
  role: string;
  exp?: number;
}

/** Decode (NOT verify) a JWT payload. The server verifies; this is for UI gating only. */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const parsed = JSON.parse(json) as Partial<JwtClaims>;
    if (typeof parsed.sub !== 'string' || typeof parsed.role !== 'string') return null;
    return { sub: parsed.sub, role: parsed.role, exp: parsed.exp };
  } catch {
    return null;
  }
}

export function isExpired(claims: JwtClaims, nowMs: number = Date.now()): boolean {
  return claims.exp !== undefined && claims.exp * 1000 <= nowMs;
}
