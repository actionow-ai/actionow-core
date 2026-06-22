import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { config } from '../../config';
import type { ApiClient } from '../api/client';
import { createClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { SdkClient } from '../api/sdkClient';
import { createSdkClient } from '../api/sdkClient';
import { decodeJwt, isExpired } from './jwt';

const TOKEN_KEY = 'actionow.token';

export interface AuthUser {
  id: string;
  role: string;
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
  /** Adopt an already-issued JWT (the OAuth callback hand-off). Validates +
   *  stores it like a login; throws on a malformed/expired token. */
  setSession: (token: string) => AuthUser;
  logout: () => void;
}
const Ctx = createContext<AuthCtx | null>(null);

function loadToken(): string | null {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  const claims = decodeJwt(t);
  if (!claims || isExpired(claims)) {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return t;
}

function userFromToken(token: string | null): AuthUser | null {
  if (!token) return null;
  const c = decodeJwt(token);
  return c ? { id: c.sub, role: c.role } : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(loadToken);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const clearToken = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  // A 401 only forces logout when the token is actually absent/expired. A 401
  // with a still-valid JWT means "not authorized for THIS resource" (e.g. an
  // admin hitting a tenant-scoped /console/* endpoint) — surface the error to
  // the query instead of nuking a valid session.
  const handleUnauthorized = useCallback(() => {
    const tok = tokenRef.current;
    const claims = tok !== null ? decodeJwt(tok) : null;
    if (tok === null || claims === null || isExpired(claims)) clearToken();
  }, [clearToken]);

  const client = useMemo<ApiClient>(
    () => createClient({ getToken: () => tokenRef.current, onUnauthorized: handleUnauthorized }),
    [handleUnauthorized],
  );

  // The typed SDK client reads the token PER REQUEST via the same ref, so it
  // survives token changes without rebuilding (only the callback is a dep).
  const sdk = useMemo<SdkClient>(
    () => createSdkClient({ getToken: () => tokenRef.current, onUnauthorized: handleUnauthorized }),
    [handleUnauthorized],
  );

  // Validate + persist an issued JWT (shared by login/register and the OAuth
  // callback). Throws on a malformed/expired token so callers can show an error.
  const setSession = useCallback((tok: string): AuthUser => {
    const claims = decodeJwt(tok);
    if (!claims || isExpired(claims)) throw new ApiError('invalid_input', 'malformed token', 200);
    localStorage.setItem(TOKEN_KEY, tok);
    setToken(tok);
    return { id: claims.sub, role: claims.role };
  }, []);

  const authenticate = useCallback(
    async (path: string, email: string, password: string): Promise<AuthUser> => {
      const r = await createClient({ getToken: () => null, onUnauthorized: () => undefined }).post<{
        token: string;
      }>(`${config.authBase}${path}`, { email, password });
      return setSession(r.token);
    },
    [setSession],
  );

  const login = useCallback((email: string, password: string) => authenticate('/login', email, password), [authenticate]);
  const register = useCallback(
    (email: string, password: string) => authenticate('/register', email, password),
    [authenticate],
  );

  const logout = useCallback(() => clearToken(), [clearToken]);

  useEffect(() => {
    const onFocus = () => {
      const c = token ? decodeJwt(token) : null;
      if (token && (!c || isExpired(c))) clearToken();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [token, clearToken]);

  const value = useMemo<AuthCtx>(
    () => ({
      user: userFromToken(token),
      isAuthed: token !== null,
      client,
      sdk,
      onUnauthorized: handleUnauthorized,
      login,
      register,
      setSession,
      logout,
    }),
    [token, client, sdk, handleUnauthorized, login, register, setSession, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
