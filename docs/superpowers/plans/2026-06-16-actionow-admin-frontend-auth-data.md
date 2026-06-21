# Actionow Admin Frontend — Plan 2: Auth + Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Builds on Plan 1 (Foundation).

**Goal:** Add the authentication layer (unified `/auth/login` + `role==='admin'` gate + protected routes) and the typed data layer (API client over the §4.7 error envelope, BigInt-safe µcredit `Money` util, typed `/admin/*` endpoints, keyset pagination hook) — the plumbing every MVP screen needs.

**Architecture:** A framework-agnostic `fetch` client holds a current token + a `401` handler (set by the React `AuthProvider`, so the client stays decoupled from React). Auth state lives in `AuthProvider` (token in `localStorage`, role decoded from the JWT). Money never round-trips through JS floats — µcredit strings are formatted directly from `BigInt`.

**Tech Stack:** TanStack Query v5, React Router v7, TypeScript. No new deps.

**Backend contracts (verified in code):**
- `POST /auth/login {email,password} → { token }`; JWT claims `{ sub, role }` signed with `ADMIN_JWT_SECRET`; `role ∈ {'user','admin'}` ([`local-auth.service.ts`](apps/api/src/auth/local-auth.service.ts)).
- `/admin/*` requires `Authorization: Bearer <jwt>`; class-level `@Roles('admin')` → a `user`-role token gets `unauthorized` ([`admin.guard.ts`](apps/api/src/admin/auth/admin.guard.ts)).
- Error envelope: `{ error: { code, message, retryable, retry_after_ms?, upstream? } }` ([`unified-error.filter.ts`](apps/api/src/common/unified-error.filter.ts)). Codes: `invalid_input`(400) `unauthorized`(401) `insufficient_credits`(402) `resource_not_found`(404) `content_filtered`(422) `rate_limited`(429) `upstream_error`(502) `upstream_timeout`(504) `job_failed|internal_error`(500).
- Admin response views are snake_case; money is decimal **µcredit strings** ([`admin.controller.ts`](apps/api/src/admin/admin.controller.ts)).

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-admin-frontend-design.md` §10 (auth), §11 (data layer).

---

## Conventions

- Branch from latest backend (spec §17.5). Touch only `apps/admin`. TDD; commit per task; don't push.
- After each task: `pnpm --filter @actionow/admin typecheck && lint && test` stays green.

## File Structure (this plan)

```
apps/admin/src/
  config.ts
  lib/
    api/{client.ts, errors.ts, admin.ts, types.ts}
    auth/{jwt.ts, AuthProvider.tsx, ProtectedRoute.tsx}
    money.ts
    query.ts            # useKeyset
  features/auth/        # (login screen lands in Plan 3)
```

---

## Task 1: Config + `ApiError` + the fetch client

**Files:**
- Create: `apps/admin/src/config.ts`, `apps/admin/src/lib/api/errors.ts`, `apps/admin/src/lib/api/client.ts`
- Test: `apps/admin/src/lib/api/client.test.ts`

- [ ] **Step 1: Create `config.ts`**

```ts
export const config = {
  /** API origin; '' means same-origin (dev uses the Vite proxy). */
  apiBase: import.meta.env.VITE_API_BASE_URL ?? '',
  /** Unified auth base path (Phase 9). */
  authBase: '/auth',
  /** Reserve OAuth buttons until the backend wires the SPA redirect handoff. */
  oauthEnabled: import.meta.env.VITE_OAUTH_ENABLED === 'true',
};
```

- [ ] **Step 2: Create `errors.ts`**

```ts
/** Mirrors the §4.7 envelope's `error` object as a thrown error. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown locally when a valid login is not an admin (role gate, not a server error). */
export class NotAdminError extends ApiError {
  constructor() {
    super('forbidden_not_admin', 'not an admin account', 403, false);
    this.name = 'NotAdminError';
  }
}
```

- [ ] **Step 3: Write the failing test**

`apps/admin/src/lib/api/client.test.ts`:
```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ApiError } from './errors';
import { createClient } from './client';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function res(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

test('GET returns parsed JSON and sends the bearer token', async () => {
  fetchMock.mockReturnValueOnce(res(200, [{ id: 't1' }]));
  const client = createClient({ getToken: () => 'tok', onUnauthorized: () => {} });
  const out = await client.get<{ id: string }[]>('/admin/tenants');
  expect(out).toEqual([{ id: 't1' }]);
  const [, init] = fetchMock.mock.calls[0];
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
});

test('maps the §4.7 envelope to ApiError', async () => {
  fetchMock.mockReturnValue(
    res(402, { error: { code: 'insufficient_credits', message: 'low', retryable: false } }),
  );
  const client = createClient({ getToken: () => null, onUnauthorized: () => {} });
  await expect(client.get('/x')).rejects.toMatchObject({
    code: 'insufficient_credits',
    status: 402,
  });
  await expect(client.get('/x')).rejects.toBeInstanceOf(ApiError);
});

test('invokes onUnauthorized on 401', async () => {
  fetchMock.mockReturnValue(
    res(401, { error: { code: 'unauthorized', message: 'no', retryable: false } }),
  );
  const onUnauthorized = vi.fn();
  const client = createClient({ getToken: () => 'x', onUnauthorized });
  await expect(client.get('/x')).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test client`
Expected: FAIL — cannot find `./client`.

- [ ] **Step 5: Implement `client.ts`**

```ts
import { config } from '../../config';
import { ApiError } from './errors';

export interface ClientDeps {
  getToken: () => string | null;
  onUnauthorized: () => void;
}

interface RequestInitLite {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query?: RequestInitLite['query']): string {
  const url = config.apiBase + path;
  if (!query) return url;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${url}?${qs}` : url;
}

export function createClient(deps: ClientDeps) {
  async function request<T>(path: string, init: RequestInitLite = {}): Promise<T> {
    const token = deps.getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(buildUrl(path, init.query), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401) deps.onUnauthorized();
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string, query?: RequestInitLite['query']) => request<T>(path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  };
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; retryable?: boolean; retry_after_ms?: number };
    };
    const e = body.error;
    if (e?.code) {
      return new ApiError(e.code, e.message ?? e.code, res.status, e.retryable ?? false, e.retry_after_ms);
    }
  } catch {
    // fall through to a generic error below
  }
  return new ApiError('internal_error', `HTTP ${res.status}`, res.status, false);
}

export type ApiClient = ReturnType<typeof createClient>;
```

- [ ] **Step 6: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test client`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/config.ts apps/admin/src/lib/api
git commit -m "feat(admin): fetch client + ApiError over the unified error envelope"
```

---

## Task 2: `Money` (BigInt µcredit formatting)

**Files:**
- Create: `apps/admin/src/lib/money.ts`
- Test: `apps/admin/src/lib/money.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/money.test.ts`:
```ts
import { expect, test } from 'vitest';

import { formatCredits, microToCreditsNumber } from './money';

test('formats µcredit strings to credits without float drift', () => {
  expect(formatCredits('100500000', 'en')).toBe('100.5');
  expect(formatCredits('1000000', 'en')).toBe('1');
  expect(formatCredits('0', 'en')).toBe('0');
  expect(formatCredits('1234567000000', 'en')).toBe('1,234,567');
  expect(formatCredits('-2500000', 'en')).toBe('-2.5');
});

test('truncates to maxFrac digits', () => {
  expect(formatCredits('1239900', 'en', 2)).toBe('1.23');
});

test('microToCreditsNumber is for small display values', () => {
  expect(microToCreditsNumber('2500000')).toBe(2.5);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test money`
Expected: FAIL — cannot find `./money`.

- [ ] **Step 3: Implement `money.ts`**

```ts
const MICRO_DIGITS = 6;

/**
 * Format a stored µcredit decimal string as human credits, locale-grouped,
 * truncated to `maxFrac` fractional digits — computed entirely on the integer
 * string so no value passes through a JS float.
 */
export function formatCredits(micro: string, locale = 'zh-CN', maxFrac = 2): string {
  const neg = micro.startsWith('-');
  const digits = (neg ? micro.slice(1) : micro).replace(/\D/g, '').padStart(MICRO_DIGITS + 1, '0');
  const whole = digits.slice(0, digits.length - MICRO_DIGITS);
  const fracFull = digits.slice(digits.length - MICRO_DIGITS);
  const frac = fracFull.slice(0, maxFrac).replace(/0+$/, '');
  const grouped = new Intl.NumberFormat(locale).format(BigInt(whole));
  return (neg ? '-' : '') + grouped + (frac ? `.${frac}` : '');
}

/** Convenience for small display values only (loses precision past ~9e9). */
export function microToCreditsNumber(micro: string): number {
  return Number(BigInt(micro)) / 1_000_000;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test money`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/money.ts apps/admin/src/lib/money.test.ts
git commit -m "feat(admin): bigint-safe µcredit money formatting"
```

---

## Task 3: JWT decode util

**Files:**
- Create: `apps/admin/src/lib/auth/jwt.ts`
- Test: `apps/admin/src/lib/auth/jwt.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/auth/jwt.test.ts`:
```ts
import { expect, test } from 'vitest';

import { decodeJwt, isExpired } from './jwt';

function makeToken(payload: object): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

test('decodes sub/role/exp from a JWT payload', () => {
  const claims = decodeJwt(makeToken({ sub: 'u1', role: 'admin', exp: 9999999999 }));
  expect(claims).toMatchObject({ sub: 'u1', role: 'admin' });
});

test('returns null for a malformed token', () => {
  expect(decodeJwt('not-a-jwt')).toBeNull();
});

test('isExpired compares exp (seconds) to now (ms)', () => {
  expect(isExpired({ sub: 'u', role: 'admin', exp: 1 }, 5000)).toBe(true);
  expect(isExpired({ sub: 'u', role: 'admin', exp: 10 }, 5000)).toBe(false);
  expect(isExpired({ sub: 'u', role: 'admin' }, 5000)).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test jwt`
Expected: FAIL — cannot find `./jwt`.

- [ ] **Step 3: Implement `jwt.ts`**

```ts
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
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test jwt`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/auth/jwt.ts apps/admin/src/lib/auth/jwt.test.ts
git commit -m "feat(admin): jwt payload decode + expiry helpers"
```

---

## Task 4: `AuthProvider` (login via `/auth/login`, role gate, token store)

**Files:**
- Create: `apps/admin/src/lib/auth/AuthProvider.tsx`
- Test: `apps/admin/src/lib/auth/AuthProvider.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/auth/AuthProvider.test.tsx`:
```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { NotAdminError } from '../api/errors';
import { AuthProvider, useAuth } from './AuthProvider';

const fetchMock = vi.fn();
function tokenWith(role: string) {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', role, exp: 9999999999 })}.sig`;
}
function res(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

function Probe() {
  const { user, login } = useAuth();
  return (
    <div>
      <span>role:{user?.role ?? 'none'}</span>
      <button onClick={() => void login('a@b.c', 'pw').catch(() => {})}>login</button>
    </div>
  );
}

test('admin login stores the token and exposes the role', async () => {
  fetchMock.mockReturnValueOnce(res(200, { token: tokenWith('admin') }));
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await act(async () => {
    screen.getByText('login').click();
  });
  await waitFor(() => expect(screen.getByText('role:admin')).toBeInTheDocument());
  expect(localStorage.getItem('actionow.token')).toContain('.');
});

test('a non-admin login is rejected with NotAdminError and stores nothing', async () => {
  fetchMock.mockReturnValueOnce(res(200, { token: tokenWith('user') }));
  let captured: unknown;
  function Probe2() {
    const { login } = useAuth();
    return <button onClick={() => void login('a@b.c', 'pw').catch((e) => (captured = e))}>go</button>;
  }
  render(
    <AuthProvider>
      <Probe2 />
    </AuthProvider>,
  );
  await act(async () => {
    screen.getByText('go').click();
  });
  await waitFor(() => expect(captured).toBeInstanceOf(NotAdminError));
  expect(localStorage.getItem('actionow.token')).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test AuthProvider`
Expected: FAIL — cannot find `./AuthProvider`.

- [ ] **Step 3: Implement `AuthProvider.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { config } from '../../config';
import { createClient } from '../api/client';
import type { ApiClient } from '../api/client';
import { ApiError, NotAdminError } from '../api/errors';
import { decodeJwt, isExpired } from './jwt';
import type { JwtClaims } from './jwt';

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
  // A ref so the (stable) client closure always reads the current token.
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
    const r = await createClient({ getToken: () => null, onUnauthorized: () => {} }).post<{
      token: string;
    }>(`${config.authBase}/login`, { email, password });
    const claims: JwtClaims | null = decodeJwt(r.token);
    if (!claims) throw new ApiError('invalid_input', 'malformed token', 200);
    if (claims.role !== 'admin') throw new NotAdminError();
    localStorage.setItem(TOKEN_KEY, r.token);
    setToken(r.token);
  }, []);

  const logout = useCallback(() => clearToken(), [clearToken]);

  // Revalidate on focus (expiry).
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
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test AuthProvider`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/auth/AuthProvider.tsx apps/admin/src/lib/auth/AuthProvider.test.tsx
git commit -m "feat(admin): auth provider — /auth/login, admin role gate, token store"
```

---

## Task 5: `ProtectedRoute`

**Files:**
- Create: `apps/admin/src/lib/auth/ProtectedRoute.tsx`
- Test: `apps/admin/src/lib/auth/ProtectedRoute.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/auth/ProtectedRoute.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test } from 'vitest';

import { AuthProvider } from './AuthProvider';
import { ProtectedRoute } from './ProtectedRoute';

function adminToken() {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', role: 'admin', exp: 9999999999 })}.sig`;
}

afterEach(() => localStorage.clear());

function tree() {
  return (
    <AuthProvider>
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/secret" element={<div>secret</div>} />
          </Route>
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

test('redirects to /login when unauthenticated', () => {
  render(tree());
  expect(screen.getByText('login-page')).toBeInTheDocument();
});

test('renders the protected outlet for an admin token', () => {
  localStorage.setItem('actionow.token', adminToken());
  render(tree());
  expect(screen.getByText('secret')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test ProtectedRoute`
Expected: FAIL — cannot find `./ProtectedRoute`.

- [ ] **Step 3: Implement `ProtectedRoute.tsx`**

```tsx
import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from './AuthProvider';

export function ProtectedRoute() {
  const { user } = useAuth();
  if (!user || user.role !== 'admin') return <Navigate to="/login" replace />;
  return <Outlet />;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test ProtectedRoute`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/auth/ProtectedRoute.tsx apps/admin/src/lib/auth/ProtectedRoute.test.tsx
git commit -m "feat(admin): protected route (admin-only)"
```

---

## Task 6: Typed admin API surface (`types.ts`, `admin.ts`)

**Files:**
- Create: `apps/admin/src/lib/api/types.ts`, `apps/admin/src/lib/api/admin.ts`
- Test: `apps/admin/src/lib/api/admin.test.ts`

- [ ] **Step 1: Create `types.ts` (mirrors the controller JSON views)**

```ts
export interface TenantView {
  id: string;
  name: string;
  isolation_mode: string;
  created_at: string;
}
export interface AccountView {
  id: string;
  tenant_id: string;
  credit_balance: string; // µcredit decimal string
  credit_held: string;
  created_at: string;
}
export interface ApiKeyView {
  id: string;
  tenant_id: string;
  resource_allowlist: string[];
  rate_limit: number | null;
  status: string;
  created_at: string;
}
export interface ApiKeyCreatedView {
  id: string;
  plaintext: string; // returned ONCE
}
export interface ResourceView {
  id: string;
  tenant_id: string;
  kind: string;
  modality: string;
  provider_type: string;
  exec_modes: string[];
  status: string;
  current_version: number;
  created_at: string;
}
export interface JobView {
  job_id: string;
  tenant_id: string;
  resource_id: string;
  status: string;
  exec_mode: string;
  cost: string | null; // µcredit decimal string
  created_at: string;
}
export interface LedgerView {
  id: string;
  tenant_id: string;
  account_id: string;
  type: string;
  credits_delta: string;
  balance_after: string;
  resource_id: string | null;
  job_id: string | null;
  created_at: string;
}
export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

// ---- request bodies (human credits, not µcredits) ----
export interface CreateTenantBody {
  name: string;
  isolationMode?: 'field' | 'schema' | 'db';
}
export interface CreateAccountBody {
  tenantId: string;
  credits?: number;
}
export interface TopupBody {
  credits: number;
}
export interface CreateApiKeyBody {
  tenantId: string;
  resourceAllowlist?: string[];
  rateLimit?: number;
}
```

- [ ] **Step 2: Write the failing test**

`apps/admin/src/lib/api/admin.test.ts`:
```ts
import { expect, test, vi } from 'vitest';

import type { ApiClient } from './client';
import { makeAdminApi } from './admin';

test('listJobs maps the {jobs,next_cursor} envelope to a Page and passes keyset params', async () => {
  const get = vi.fn().mockResolvedValue({ jobs: [{ job_id: 'j1' }], next_cursor: 'c2' });
  const client = { get, post: vi.fn() } as unknown as ApiClient;
  const api = makeAdminApi(client);

  const page = await api.listJobs({ tenantId: 't1', cursor: 'c1', limit: 50 });
  expect(page).toEqual({ rows: [{ job_id: 'j1' }], nextCursor: 'c2' });
  expect(get).toHaveBeenCalledWith('/admin/jobs', { tenantId: 't1', cursor: 'c1', limit: 50 });
});

test('createTenant POSTs to /admin/tenants', async () => {
  const post = vi.fn().mockResolvedValue({ id: 't1' });
  const client = { get: vi.fn(), post } as unknown as ApiClient;
  await makeAdminApi(client).createTenant({ name: 'acme' });
  expect(post).toHaveBeenCalledWith('/admin/tenants', { name: 'acme' });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test api/admin`
Expected: FAIL — cannot find `./admin`.

- [ ] **Step 4: Implement `admin.ts`**

```ts
import type { ApiClient } from './client';
import type {
  AccountView,
  ApiKeyCreatedView,
  ApiKeyView,
  CreateAccountBody,
  CreateApiKeyBody,
  CreateTenantBody,
  JobView,
  LedgerView,
  Page,
  ResourceView,
  TenantView,
  TopupBody,
} from './types';

interface KeysetParams {
  tenantId: string;
  cursor?: string;
  limit?: number;
}

export function makeAdminApi(client: ApiClient) {
  return {
    listTenants: () => client.get<TenantView[]>('/admin/tenants'),
    createTenant: (body: CreateTenantBody) => client.post<TenantView>('/admin/tenants', body),

    listResources: () => client.get<ResourceView[]>('/admin/resources'),

    createAccount: (body: CreateAccountBody) => client.post<AccountView>('/admin/accounts', body),
    topup: (accountId: string, body: TopupBody) =>
      client.post<{ account_id: string; balance: string }>(`/admin/accounts/${accountId}/topup`, body),

    listApiKeys: (tenantId: string) =>
      client.get<ApiKeyView[]>('/admin/api-keys', { tenantId }),
    createApiKey: (body: CreateApiKeyBody) =>
      client.post<ApiKeyCreatedView>('/admin/api-keys', body),

    listJobs: async ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<JobView>> => {
      const r = await client.get<{ jobs: JobView[]; next_cursor: string | null }>('/admin/jobs', {
        tenantId,
        cursor,
        limit,
      });
      return { rows: r.jobs, nextCursor: r.next_cursor };
    },
    listLedger: async ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<LedgerView>> => {
      const r = await client.get<{ transactions: LedgerView[]; next_cursor: string | null }>(
        '/admin/ledger',
        { tenantId, cursor, limit },
      );
      return { rows: r.transactions, nextCursor: r.next_cursor };
    },
  };
}

export type AdminApi = ReturnType<typeof makeAdminApi>;
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test api/admin`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/api/types.ts apps/admin/src/lib/api/admin.ts apps/admin/src/lib/api/admin.test.ts
git commit -m "feat(admin): typed /admin api surface + view types"
```

---

## Task 7: `useKeyset` pagination hook + `useAdminApi`

**Files:**
- Create: `apps/admin/src/lib/query.ts`, `apps/admin/src/lib/api/useAdminApi.ts`
- Test: `apps/admin/src/lib/query.test.tsx`

- [ ] **Step 1: Create `useAdminApi.ts` (binds the api to the auth client)**

```ts
import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { makeAdminApi } from './admin';
import type { AdminApi } from './admin';

export function useAdminApi(): AdminApi {
  const { client } = useAuth();
  return useMemo(() => makeAdminApi(client), [client]);
}
```

- [ ] **Step 2: Write the failing test (keyset accumulates pages)**

`apps/admin/src/lib/query.test.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';

import type { Page } from './api/types';
import { useKeyset } from './query';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

test('loads the first page then appends the next', async () => {
  const fetchPage = vi
    .fn<[string | undefined], Promise<Page<{ id: string }>>>()
    .mockResolvedValueOnce({ rows: [{ id: 'a' }], nextCursor: 'c1' })
    .mockResolvedValueOnce({ rows: [{ id: 'b' }], nextCursor: null });

  const { result } = renderHook(() => useKeyset(['x'], fetchPage), { wrapper: wrapper() });

  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.hasNext).toBe(true);

  await act(async () => {
    await result.current.fetchNext();
  });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));
  expect(result.current.hasNext).toBe(false);
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test query`
Expected: FAIL — cannot find `./query`.

- [ ] **Step 4: Implement `query.ts`**

```ts
import { useInfiniteQuery } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';

import type { Page } from './api/types';

/**
 * Keyset-paginated list backed by `useInfiniteQuery`. `fetchPage(cursor)` returns
 * `{ rows, nextCursor }`; the hook flattens all loaded pages into `rows`.
 */
export function useKeyset<T>(key: QueryKey, fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  return {
    rows: (q.data?.pages ?? []).flatMap((p) => p.rows),
    hasNext: q.hasNextPage,
    isLoading: q.isLoading,
    isFetchingNext: q.isFetchingNextPage,
    error: q.error as unknown,
    fetchNext: () => q.fetchNextPage(),
    refetch: () => q.refetch(),
  };
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test query`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/query.ts apps/admin/src/lib/api/useAdminApi.ts apps/admin/src/lib/query.test.tsx
git commit -m "feat(admin): useKeyset pagination + useAdminApi binding"
```

---

## Task 8: Wire `AuthProvider` into `App`; protect the shell

**Files:**
- Modify: `apps/admin/src/App.tsx`, `apps/admin/src/routes.tsx`

- [ ] **Step 1: Wrap the app in `AuthProvider`**

Edit `apps/admin/src/App.tsx` — add the import and wrap `<BrowserRouter>`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from './lib/auth/AuthProvider';
import { ThemeProvider } from './lib/theme/ThemeProvider';
import { AppRoutes } from './routes';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Suspense fallback={null}>
              <AppRoutes />
            </Suspense>
          </BrowserRouter>
        </QueryClientProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Gate the shell behind `ProtectedRoute`; add the `/login` placeholder route**

Edit `apps/admin/src/routes.tsx`:
```tsx
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/layout/AppShell';
import { ProtectedRoute } from './lib/auth/ProtectedRoute';
import { PlaceholderPage } from './features/placeholder/PlaceholderPage';

export function AppRoutes() {
  return (
    <Routes>
      {/* Login screen lands in Plan 3; a placeholder keeps the route resolvable. */}
      <Route path="/login" element={<PlaceholderPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<PlaceholderPage />} />
          <Route path="/tenants" element={<PlaceholderPage />} />
          <Route path="/accounts" element={<PlaceholderPage />} />
          <Route path="/api-keys" element={<PlaceholderPage />} />
          <Route path="/ledger" element={<PlaceholderPage />} />
          <Route path="/payments" element={<PlaceholderPage />} />
          <Route path="/resources" element={<PlaceholderPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 3: Verify build + behavior**

Run: `pnpm --filter @actionow/admin build`
Expected: PASS.

Run (smoke, then Ctrl-C): `pnpm --filter @actionow/admin dev`
Expected: visiting `/` with no token redirects to `/login` (placeholder). (Full login screen + real redirect comes in Plan 3.)

- [ ] **Step 4: Verification gate + commit**

Run: `pnpm --filter @actionow/admin typecheck && pnpm --filter @actionow/admin lint && pnpm --filter @actionow/admin test`
Expected: PASS (all Plan 1 + Plan 2 tests).

```bash
git add apps/admin/src/App.tsx apps/admin/src/routes.tsx
git commit -m "feat(admin): wire auth provider + protect the shell"
```

---

## Plan 2 Definition of Done

- `fetch` client maps the §4.7 envelope to `ApiError`, injects the bearer token, and fires `onUnauthorized` on 401.
- `Money` formats µcredit strings via BigInt (no float drift); JWT decode + expiry helpers.
- `AuthProvider`: `/auth/login` → token, **admin role gate** (`NotAdminError` for non-admins), `localStorage` persistence, focus revalidation; `ProtectedRoute` admin-only.
- Typed `/admin/*` API (`makeAdminApi`) + `useAdminApi` + `useKeyset` keyset hook.
- Shell is behind `ProtectedRoute`; unauthenticated `/` → `/login`. `typecheck/lint/test/build` green.

> **Next:** Plan 3 — MVP screens (coss primitives → Login, Dashboard, Tenants, Accounts + top-up, API Keys) + per-feature i18n namespaces + `DataTable`/`StatusBadge`/`CopyField`.
