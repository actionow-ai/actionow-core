import type { HttpClient } from '@actionow/contracts';

/** The public OAuth client id the codex/ChatGPT CLI uses (verbatim from upstream). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Codex OAuth token endpoint; the refresh grant POSTs form-encoded here. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
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
