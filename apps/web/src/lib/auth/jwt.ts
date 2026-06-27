export interface JwtClaims {
  sub: string;
  role: string;
  exp?: number;
  /** Member (end-user) tokens carry `typ:'subject'` instead of an operator `role`. */
  typ?: string;
  /** Member tokens scope to one tenant (`tenant_id`). */
  tenantId?: string;
}

/**
 * Decode (NOT verify) a JWT payload. The server verifies; this is for UI gating
 * only. Two token shapes are accepted: operator tokens (`{sub, role}`) and member
 * (end-user) tokens (`{sub, tenant_id, typ:'subject'}`, no `role`). For a member
 * token a synthetic `role:'member'` is returned so the UI can route by role.
 */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (payload === undefined) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const parsed = JSON.parse(json) as Partial<JwtClaims> & { tenant_id?: string };
    if (typeof parsed.sub !== 'string') return null;
    // Member token: no `role`, distinguished by `typ:'subject'`.
    if (parsed.typ === 'subject') {
      return {
        sub: parsed.sub,
        role: 'member',
        typ: 'subject',
        tenantId: typeof parsed.tenant_id === 'string' ? parsed.tenant_id : undefined,
        exp: parsed.exp,
      };
    }
    if (typeof parsed.role !== 'string') return null;
    return { sub: parsed.sub, role: parsed.role, exp: parsed.exp };
  } catch {
    return null;
  }
}

export function isExpired(claims: JwtClaims, nowMs: number = Date.now()): boolean {
  return claims.exp !== undefined && claims.exp * 1000 <= nowMs;
}
