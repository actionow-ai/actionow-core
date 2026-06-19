import { createHash, randomBytes } from 'node:crypto';

import type { HttpClient } from '@actionow/contracts';

/** The public OAuth client id the codex/ChatGPT CLI uses (verbatim from upstream). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Codex OAuth token endpoint; the refresh grant POSTs form-encoded here. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** Codex OAuth authorize endpoint; the login flow redirects the operator here. */
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
/** Loopback redirect URI the codex CLI registers for the authorization-code flow. */
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
/** Authorize-time scope (broader than refresh; requests offline_access for a refresh token). */
export const CODEX_AUTHORIZE_SCOPE = 'openid email profile offline_access';
/** Refresh proactively when fewer than this many ms remain until expiry. */
export const CODEX_REFRESH_LEAD_MS = 5 * 60_000;

/** Minimal identity claims lifted from a (NOT verified) ChatGPT id_token. */
export interface CodexIdentity {
  accountId?: string | undefined;
  email?: string | undefined;
  plan?: string | undefined;
}

/** Local string-narrowing helper (engine cannot import the adapters json utils). */
function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

/** Local finite-number narrowing helper. */
function asNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/** Local plain-object narrowing helper. */
function asRecord(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;
}

/**
 * Decode (but do NOT verify) the id_token JWT and read the ChatGPT identity
 * claims: `chatgpt_account_id` / `chatgpt_plan_type` live under the
 * `https://api.openai.com/auth` claim, `email` is a top-level claim. Returns an
 * empty identity (all-undefined) for any malformed input — never throws.
 */
export function parseChatgptIdentity(idToken: string): CodexIdentity {
  const segment = idToken.split('.')[1];
  if (segment === undefined || segment === '') return {};
  let claims: Record<string, unknown> | undefined;
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    claims = asRecord(JSON.parse(json));
  } catch {
    return {};
  }
  if (claims === undefined) return {};
  const auth = asRecord(claims['https://api.openai.com/auth']);
  return {
    accountId: asString(auth?.chatgpt_account_id),
    email: asString(claims.email),
    plan: asString(auth?.chatgpt_plan_type),
  };
}

/**
 * Generate a PKCE pair for the codex authorization-code flow. The verifier is a
 * 64-byte hex string (128 chars); the S256 challenge is the base64url-encoded
 * SHA-256 of the verifier.
 */
export function generateCodexPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the codex OAuth authorize URL the operator's browser is redirected to.
 * `state` is the caller's CSRF/correlation token; `codeChallenge` is the PKCE
 * S256 challenge from {@link generateCodexPkce}.
 */
export function buildCodexAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
  // VERIFY against a real codex login — these params are from source study and
  // have not yet been validated against the live authorize endpoint.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_AUTHORIZE_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: params.state,
  });
  return `${CODEX_AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * A codex refresh failure. `terminal` distinguishes a dead refresh token
 * (token reused / HTTP 400/401 → caller marks the session needs_reauth) from a
 * transient condition (HTTP 429 → caller backs off and retries).
 */
export class CodexRefreshError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = 'CodexRefreshError';
  }
}

/** The rotated token set returned by a successful refresh. */
export interface CodexTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string | undefined;
  expiresAt: Date;
}

/**
 * POST the `refresh_token` grant to {@link CODEX_TOKEN_URL} (form-encoded) and
 * return the rotated {@link CodexTokenSet}. The refresh token falls back to the
 * input when the response omits one (some providers do not rotate it).
 *
 * Throws {@link CodexRefreshError} with `terminal=true` for a reused token or
 * HTTP 400/401 (the refresh token is dead), and `terminal=false` for HTTP 429
 * (rate limited — retry later). Any other non-ok status is treated as terminal.
 */
export async function refreshCodexToken(
  http: HttpClient,
  refreshToken: string,
  now: Date,
): Promise<CodexTokenSet> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid profile email',
  }).toString();

  const res = await http.request({
    method: 'POST',
    url: CODEX_TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const detail = `${res.text}${JSON.stringify(res.body ?? '')}`;
    if (detail.includes('refresh_token_reused')) {
      throw new CodexRefreshError('refresh token reused', true);
    }
    if (res.status === 429) {
      throw new CodexRefreshError('rate limited', false);
    }
    if (res.status === 400 || res.status === 401) {
      throw new CodexRefreshError(`refresh rejected (${String(res.status)})`, true);
    }
    throw new CodexRefreshError(`refresh failed (${String(res.status)})`, true);
  }

  const obj = asRecord(res.body) ?? {};
  const accessToken = asString(obj.access_token);
  if (accessToken === undefined) {
    throw new CodexRefreshError('refresh response missing access_token', true);
  }
  const expiresIn = asNumber(obj.expires_in) ?? 0;
  return {
    accessToken,
    refreshToken: asString(obj.refresh_token) ?? refreshToken,
    idToken: asString(obj.id_token),
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
  };
}

/**
 * A codex authorization-code exchange failure. `terminal` distinguishes a
 * rejected/invalid code (HTTP 400/401, or a malformed response → the login
 * cannot complete) from a transient condition (HTTP 429 → retry later). A thin
 * sibling to {@link CodexRefreshError} for the login (exchange) path.
 */
export class CodexAuthError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

/**
 * POST the `authorization_code` grant to {@link CODEX_TOKEN_URL} (form-encoded)
 * and return the {@link CodexTokenSet}. Both `access_token` and `refresh_token`
 * are required here — the authorize step requested `offline_access`, so the
 * provider must return a refresh token to complete a turnkey login.
 *
 * Throws {@link CodexAuthError} with `terminal=true` for HTTP 400/401 (the code
 * is rejected) or a malformed response, and `terminal=false` for HTTP 429 (rate
 * limited — retry later). Any other non-ok status is treated as terminal.
 */
export async function exchangeCodexCode(
  http: HttpClient,
  args: { code: string; codeVerifier: string },
  now: Date,
): Promise<CodexTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code: args.code,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: args.codeVerifier,
  }).toString();

  const res = await http.request({
    method: 'POST',
    url: CODEX_TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    if (res.status === 429) {
      throw new CodexAuthError('rate limited', false);
    }
    if (res.status === 400 || res.status === 401) {
      throw new CodexAuthError(`code exchange rejected (${String(res.status)})`, true);
    }
    throw new CodexAuthError(`code exchange failed (${String(res.status)})`, true);
  }

  const obj = asRecord(res.body) ?? {};
  const accessToken = asString(obj.access_token);
  if (accessToken === undefined) {
    throw new CodexAuthError('exchange response missing access_token', true);
  }
  const refreshToken = asString(obj.refresh_token);
  if (refreshToken === undefined) {
    throw new CodexAuthError('exchange response missing refresh_token', true);
  }
  const expiresIn = asNumber(obj.expires_in) ?? 0;
  return {
    accessToken,
    refreshToken,
    idToken: asString(obj.id_token),
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
  };
}
