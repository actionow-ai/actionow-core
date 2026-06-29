import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { config } from '../../config';
import type { ApiClient } from '../api/client';
import { createClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { SdkClient } from '../api/sdkClient';
import { createSdkClient } from '../api/sdkClient';
import type { TokenPair } from '../api/types';
import { decodeJwt, isExpired } from './jwt';

const TOKEN_KEY = 'actionow.token';
const REFRESH_KEY = 'actionow.refresh_token';
/** Renew the access token this many ms before its `exp` (avoid racing a 401). */
const REFRESH_SKEW_MS = 60_000;

export interface AuthUser {
  id: string;
  role: string;
  /** For a member (end-user) session, the tenant the subject belongs to. */
  tenantId?: string;
}

interface AuthCtx {
  user: AuthUser | null;
  isAuthed: boolean;
  /** Hand-written raw client — used for the auth plane (`/auth/*`, not in the
   *  contract) and as the hybrid fallback for a few resource methods. */
  client: ApiClient;
  /** Typed `openapi-fetch` SDK client — the primary control-plane transport. */
  sdk: SdkClient;
  /** Clears the token (logout). The resource APIs call this on a 401. */
  onUnauthorized: () => void;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, password: string) => Promise<AuthUser>;
  /** Member (end-user) auth — scoped to a tenant (unified tenancy G-F). */
  loginMember: (tenantId: string, email: string, password: string) => Promise<AuthUser>;
  registerMember: (tenantId: string, email: string, password: string) => Promise<AuthUser>;
  /** Adopt an already-issued JWT (the OAuth callback hand-off). Validates +
   *  stores it like a login; throws on a malformed/expired token. */
  setSession: (token: string) => AuthUser;
  logout: () => void;
  /** The current access token (or null) — for hand-rolled fetches the SDK/client
   *  middleware can't cover, e.g. an SSE stream read that sets its own headers. */
  getToken: () => string | null;
}
const Ctx = createContext<AuthCtx | null>(null);

/** A tokenless raw client for the `/auth/*` plane (login/refresh/logout). */
const authPlane = createClient({ getToken: () => null, onUnauthorized: () => undefined });

/** Read a stored access token if present AND still valid (else null). Never
 *  removes the refresh token — an expired access token is renewable. */
function loadAccess(): string | null {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  const claims = decodeJwt(t);
  if (!claims || isExpired(claims)) return null;
  return t;
}

function userFromToken(token: string | null): AuthUser | null {
  if (!token) return null;
  const c = decodeJwt(token);
  if (!c) return null;
  return c.tenantId !== undefined
    ? { id: c.sub, role: c.role, tenantId: c.tenantId }
    : { id: c.sub, role: c.role };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(loadAccess);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // The refresh token lives in a ref (it never drives render) + localStorage.
  const refreshRef = useRef<string | null>(localStorage.getItem(REFRESH_KEY));
  // Dedupe concurrent refreshes: rotating the same refresh token twice trips the
  // backend's theft detection (family revoke + 401), so all callers share one.
  const refreshInFlight = useRef<Promise<boolean> | null>(null);
  // True only while a boot-time refresh is in flight (expired access + a refresh
  // token on disk) — gates the app so ProtectedRoute doesn't flash a redirect.
  const [booting, setBooting] = useState<boolean>(
    () => loadAccess() === null && localStorage.getItem(REFRESH_KEY) !== null,
  );

  const storeTokens = useCallback((access: string, refresh: string | null) => {
    localStorage.setItem(TOKEN_KEY, access);
    if (refresh !== null) localStorage.setItem(REFRESH_KEY, refresh);
    else localStorage.removeItem(REFRESH_KEY);
    refreshRef.current = refresh;
    setToken(access);
  }, []);

  const clearTokens = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    refreshRef.current = null;
    setToken(null);
  }, []);

  /** Rotate the refresh token for a fresh access+refresh pair. Deduped; resolves
   *  `true` on success (tokens stored), `false` on failure (session cleared). */
  const doRefresh = useCallback((): Promise<boolean> => {
    const rt = refreshRef.current;
    if (rt === null) {
      clearTokens();
      return Promise.resolve(false);
    }
    if (refreshInFlight.current) return refreshInFlight.current;
    const p = (async () => {
      try {
        const pair = await authPlane.post<TokenPair>(`${config.authBase}/refresh`, {
          refreshToken: rt,
        });
        storeTokens(pair.accessToken, pair.refreshToken);
        return true;
      } catch {
        clearTokens();
        return false;
      } finally {
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = p;
    return p;
  }, [clearTokens, storeTokens]);

  // A 401 only forces logout when the access token is actually absent/expired. A
  // 401 with a still-valid JWT means "not authorized for THIS resource" (e.g. an
  // admin hitting a tenant-scoped /console/* endpoint) — surface it to the query.
  // An expired/absent access token with a refresh token triggers a silent rotation
  // (the failed query retries with the new token); only a failed rotation logs out.
  const handleUnauthorized = useCallback(() => {
    const tok = tokenRef.current;
    const claims = tok !== null ? decodeJwt(tok) : null;
    if (tok !== null && claims !== null && !isExpired(claims)) return; // forbidden, not expired
    void doRefresh();
  }, [doRefresh]);

  const client = useMemo<ApiClient>(
    () => createClient({ getToken: () => tokenRef.current, onUnauthorized: handleUnauthorized }),
    [handleUnauthorized],
  );
  const sdk = useMemo<SdkClient>(
    () => createSdkClient({ getToken: () => tokenRef.current, onUnauthorized: handleUnauthorized }),
    [handleUnauthorized],
  );

  // Validate + persist an issued access token WITHOUT a refresh token (the OAuth
  // callback hand-off, which only carries the access JWT in the URL fragment).
  const setSession = useCallback(
    (tok: string): AuthUser => {
      const claims = decodeJwt(tok);
      if (!claims || isExpired(claims)) throw new ApiError('invalid_input', 'malformed token', 200);
      storeTokens(tok, null);
      return claims.tenantId !== undefined
        ? { id: claims.sub, role: claims.role, tenantId: claims.tenantId }
        : { id: claims.sub, role: claims.role };
    },
    [storeTokens],
  );

  // Persist a full token pair from a login/register response (stores BOTH tokens).
  const adoptPair = useCallback(
    (pair: TokenPair): AuthUser => {
      storeTokens(pair.accessToken, pair.refreshToken);
      const claims = decodeJwt(pair.accessToken);
      if (!claims) throw new ApiError('invalid_input', 'malformed token', 200);
      return claims.tenantId !== undefined
        ? { id: claims.sub, role: claims.role, tenantId: claims.tenantId }
        : { id: claims.sub, role: claims.role };
    },
    [storeTokens],
  );

  const authenticate = useCallback(
    async (path: string, body: Record<string, string>): Promise<AuthUser> =>
      adoptPair(await authPlane.post<TokenPair>(`${config.authBase}${path}`, body)),
    [adoptPair],
  );

  const login = useCallback(
    (email: string, password: string) => authenticate('/login', { email, password }),
    [authenticate],
  );
  const register = useCallback(
    (email: string, password: string) => authenticate('/register', { email, password }),
    [authenticate],
  );
  const loginMember = useCallback(
    (tenantId: string, email: string, password: string) =>
      authenticate('/login-member', { tenantId, email, password }),
    [authenticate],
  );
  const registerMember = useCallback(
    (tenantId: string, email: string, password: string) =>
      authenticate('/register-member', { tenantId, email, password }),
    [authenticate],
  );

  // Best-effort server-side session revoke (so the refresh token can't be reused),
  // then clear locally regardless of the network outcome.
  const logout = useCallback(() => {
    const rt = refreshRef.current;
    if (rt !== null)
      void authPlane.post(`${config.authBase}/logout`, { refreshToken: rt }).catch(() => undefined);
    clearTokens();
  }, [clearTokens]);

  // Boot-time renewal: an expired access token with a refresh token on disk → one
  // rotation before the app routes, so a returning user past the access TTL lands
  // in place instead of bouncing through /login.
  useEffect(() => {
    if (!booting) return;
    void doRefresh().finally(() => setBooting(false));
  }, [booting, doRefresh]);

  // Proactive renewal: refresh shortly before the access token expires so requests
  // never race a 401. Reschedules whenever the token changes.
  useEffect(() => {
    if (token === null) return;
    const claims = decodeJwt(token);
    if (claims?.exp === undefined) return;
    const due = claims.exp * 1000 - Date.now() - REFRESH_SKEW_MS;
    const id = setTimeout(() => void doRefresh(), Math.max(0, due));
    return () => clearTimeout(id);
  }, [token, doRefresh]);

  // On window focus, renew an expired/near-gone access token instead of dropping
  // the session (a laptop that slept past the access TTL recovers silently).
  useEffect(() => {
    const onFocus = () => {
      const tok = tokenRef.current;
      const c = tok !== null ? decodeJwt(tok) : null;
      if (tok === null || c === null || isExpired(c)) {
        if (refreshRef.current !== null) void doRefresh();
        else if (tok !== null) clearTokens();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [doRefresh, clearTokens]);

  const value = useMemo<AuthCtx>(
    () => ({
      user: userFromToken(token),
      isAuthed: token !== null,
      client,
      sdk,
      onUnauthorized: handleUnauthorized,
      login,
      register,
      loginMember,
      registerMember,
      setSession,
      logout,
      getToken: () => tokenRef.current,
    }),
    [
      token,
      client,
      sdk,
      handleUnauthorized,
      login,
      register,
      loginMember,
      registerMember,
      setSession,
      logout,
    ],
  );

  // While booting (one-shot refresh in flight) render a neutral full-screen
  // placeholder so the router doesn't redirect to /login before the token lands.
  if (booting) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg)',
        }}
        aria-busy="true"
      />
    );
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/**
 * Like {@link useAuth} but returns `null` instead of throwing when rendered
 * outside an `AuthProvider`. For incidental consumers (e.g. an SSE hook) that
 * should stay inert — rather than crash — in isolated renders/tests where the
 * provider isn't mounted. The real app always mounts it at the root.
 */
export function useOptionalAuth(): AuthCtx | null {
  return useContext(Ctx);
}
