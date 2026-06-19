import { createHash } from 'node:crypto';

import type { HttpClient, HttpRequest, HttpResponse } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildCodexAuthorizeUrl,
  CODEX_AUTHORIZE_SCOPE,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_TOKEN_URL,
  CodexAuthError,
  exchangeCodexCode,
  generateCodexPkce,
} from '../src/oauth/codex.js';

/** A fake HttpClient that records the request and returns a canned response. */
function fakeHttp(response: HttpResponse): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      return Promise.resolve(response);
    },
  };
  return { http, calls };
}

const NOW = new Date('2026-06-17T00:00:00.000Z');

describe('generateCodexPkce', () => {
  it('produces a 128-char hex verifier and a base64url S256 challenge', () => {
    const { verifier, challenge } = generateCodexPkce();
    expect(verifier).toMatch(/^[0-9a-f]{128}$/);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('returns a fresh verifier on each call', () => {
    const a = generateCodexPkce();
    const b = generateCodexPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('buildCodexAuthorizeUrl', () => {
  it('builds the codex authorize URL with all source-grounded params', () => {
    const url = buildCodexAuthorizeUrl({ state: 'st-123', codeChallenge: 'chal-abc' });
    const parsed = new URL(url);
    expect(`${parsed.host}${parsed.pathname}`).toBe('auth.openai.com/oauth/authorize');

    const q = parsed.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(q.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(q.get('scope')).toBe('openid email profile offline_access');
    expect(q.get('code_challenge')).toBe('chal-abc');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('prompt')).toBe('login');
    expect(q.get('id_token_add_organizations')).toBe('true');
    expect(q.get('codex_cli_simplified_flow')).toBe('true');
    expect(q.get('state')).toBe('st-123');
  });

  it('exposes the authorize endpoint/scope constants used to build the URL', () => {
    expect(CODEX_AUTHORIZE_URL).toBe('https://auth.openai.com/oauth/authorize');
    expect(CODEX_REDIRECT_URI).toBe('http://localhost:1455/auth/callback');
    expect(CODEX_AUTHORIZE_SCOPE).toBe('openid email profile offline_access');
  });
});

describe('exchangeCodexCode', () => {
  it('posts a form-encoded authorization_code grant and returns the token set', async () => {
    const { http, calls } = fakeHttp({
      status: 200,
      ok: true,
      body: {
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      text: '',
    });

    const tokens = await exchangeCodexCode(http, { code: 'auth-code', codeVerifier: 'verif' }, NOW);

    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.idToken).toBe('idt');
    expect(tokens.expiresAt.toISOString()).toBe('2026-06-17T01:00:00.000Z');

    expect(calls).toHaveLength(1);
    const [req] = calls;
    if (req === undefined) throw new Error('expected a recorded request');
    expect(req.method).toBe('POST');
    expect(req.url).toBe(CODEX_TOKEN_URL);
    expect(req.headers?.['content-type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(String(req.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(CODEX_CLIENT_ID);
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe(CODEX_REDIRECT_URI);
    expect(body.get('code_verifier')).toBe('verif');
  });

  it('throws a terminal CodexAuthError on HTTP 400', async () => {
    const { http } = fakeHttp({ status: 400, ok: false, body: undefined, text: 'invalid_grant' });
    const err = await exchangeCodexCode(http, { code: 'c', codeVerifier: 'v' }, NOW).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CodexAuthError);
    expect((err as CodexAuthError).terminal).toBe(true);
  });

  it('throws a retryable (non-terminal) CodexAuthError on HTTP 429', async () => {
    const { http } = fakeHttp({ status: 429, ok: false, body: undefined, text: 'rate limited' });
    const err = await exchangeCodexCode(http, { code: 'c', codeVerifier: 'v' }, NOW).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CodexAuthError);
    expect((err as CodexAuthError).terminal).toBe(false);
  });

  it('throws terminal when the ok response is missing access_token', async () => {
    const { http } = fakeHttp({
      status: 200,
      ok: true,
      body: { refresh_token: 'rt', expires_in: 60 },
      text: '',
    });
    const err = await exchangeCodexCode(http, { code: 'c', codeVerifier: 'v' }, NOW).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CodexAuthError);
    expect((err as CodexAuthError).terminal).toBe(true);
  });

  it('throws terminal when the ok response is missing refresh_token', async () => {
    const { http } = fakeHttp({
      status: 200,
      ok: true,
      body: { access_token: 'at', expires_in: 60 },
      text: '',
    });
    const err = await exchangeCodexCode(http, { code: 'c', codeVerifier: 'v' }, NOW).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CodexAuthError);
    expect((err as CodexAuthError).terminal).toBe(true);
  });
});
