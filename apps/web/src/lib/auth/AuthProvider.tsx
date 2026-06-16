import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { config } from '../../config';
import type { ApiClient } from '../api/client';
import { createClient } from '../api/client';
import { ApiError, NotAdminError } from '../api/errors';
import type { JwtClaims } from './jwt';
import { decodeJwt, isExpired } from './jwt';

const TOKEN_KEY = 'actionow.token';

export interface AuthUser {
  id: string;
  role: string;
}

interface AuthCtx {
  user: AuthUser | null;
  isAuthed: boolean;
  client: ApiClient;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}
const Ctx = createContext<AuthCtx | null>(null);

function loadToken(): string | null {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  const claims = decodeJwt(t);
  if (!claims || isExpired(claims) || claims.role !== 'admin') {
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

  const login = useCallback(async (email: string, password: string) => {
    const r = await createClient({ getToken: () => null, onUnauthorized: () => undefined }).post<{
      token: string;
    }>(`${config.authBase}/login`, { email, password });
    const claims: JwtClaims | null = decodeJwt(r.token);
    if (!claims) throw new ApiError('invalid_input', 'malformed token', 200);
    if (claims.role !== 'admin') throw new NotAdminError();
    localStorage.setItem(TOKEN_KEY, r.token);
    setToken(r.token);
  }, []);

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
    () => ({ user: userFromToken(token), isAuthed: token !== null, client, login, logout }),
    [token, client, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
