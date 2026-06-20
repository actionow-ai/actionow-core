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

  const client = useMemo<ApiClient>(
    () => createClient({ getToken: () => tokenRef.current, onUnauthorized: clearToken }),
    [clearToken],
  );

  // The typed SDK client reads the token PER REQUEST via the same ref, so it
  // survives token changes without rebuilding (only `clearToken` is a dep).
  const sdk = useMemo<SdkClient>(
    () => createSdkClient({ getToken: () => tokenRef.current, onUnauthorized: clearToken }),
    [clearToken],
  );

  const authenticate = useCallback(async (path: string, email: string, password: string): Promise<AuthUser> => {
    const r = await createClient({ getToken: () => null, onUnauthorized: () => undefined }).post<{
      token: string;
    }>(`${config.authBase}${path}`, { email, password });
    const claims = decodeJwt(r.token);
    if (!claims) throw new ApiError('invalid_input', 'malformed token', 200);
    localStorage.setItem(TOKEN_KEY, r.token);
    setToken(r.token);
    return { id: claims.sub, role: claims.role };
  }, []);

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
      onUnauthorized: clearToken,
      login,
      register,
      logout,
    }),
    [token, client, sdk, clearToken, login, register, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
