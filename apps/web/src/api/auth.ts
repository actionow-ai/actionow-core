import { config } from '@/config';

/** Persisted session: the tenant/admin operator token pair from `/auth/*`. */
export interface Session {
  accessToken: string;
  /** Absent for OAuth fragment logins (no refresh token is handed to the SPA). */
  refreshToken: string | null;
}

export interface JwtPayload {
  sub?: string;
  role?: 'admin' | 'user';
  typ?: string;
  email?: string;
  exp?: number;
}

interface TokenPair {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

const STORAGE_KEY = 'actionow.session';

let session: Session | null = readStorage();
const listeners = new Set<() => void>();

function readStorage(): Session | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.accessToken !== 'string') return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken ?? null };
  } catch {
    return null;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session | null): void {
  session = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Session still applies in-memory for this tab.
  }
  notify();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Decode a JWT payload without verifying — display/routing hints only. */
export function decodeJwtPayload(token: string): JwtPayload {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      window
        .atob(normalized)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json) as JwtPayload;
  } catch {
    return {};
  }
}

export function sessionPayload(): JwtPayload | null {
  return session ? decodeJwtPayload(session.accessToken) : null;
}

async function postAuth(path: string, body: unknown): Promise<TokenPair> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } } | undefined;
    throw new AuthError(
      response.status,
      envelope?.error?.code ?? 'unknown',
      envelope?.error?.message ?? `HTTP ${String(response.status)}`,
    );
  }
  return payload as TokenPair;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/** Email+password login for tenant operators AND platform admins (`role` claim decides). */
export async function login(email: string, password: string): Promise<Session> {
  const pair = await postAuth('/auth/login', { email, password });
  const next: Session = { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  setSession(next);
  return next;
}

export async function register(email: string, password: string): Promise<Session> {
  const pair = await postAuth('/auth/register', { email, password });
  const next: Session = { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  setSession(next);
  return next;
}

let refreshInFlight: Promise<Session | null> | null = null;

/**
 * Rotate the refresh token (single-flight: concurrent 401s share one attempt).
 * Returns the new session, or null when refresh is impossible/rejected — in
 * which case the session is cleared and the caller should surface a re-login.
 */
export function refreshSession(): Promise<Session | null> {
  refreshInFlight ??= (async () => {
    const current = session;
    if (!current?.refreshToken) {
      setSession(null);
      return null;
    }
    try {
      const pair = await postAuth('/auth/refresh', { refreshToken: current.refreshToken });
      const next: Session = { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
      setSession(next);
      return next;
    } catch {
      setSession(null);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * localStorage key prefixes holding session-scoped secrets that must NOT survive
 * a logout (the next operator on a shared browser must not inherit them). The
 * playground data-plane key (namespaced per subject) lives under this prefix.
 */
const SESSION_SCOPED_PREFIXES = ['actionow.playground.key'];

export function logout(): void {
  const current = session;
  setSession(null);
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key !== null && SESSION_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Best effort; the session token is already cleared above.
  }
  if (current?.refreshToken) {
    void fetch(`${config.apiBaseUrl}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    }).catch(() => undefined);
  }
}
