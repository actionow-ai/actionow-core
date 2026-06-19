import type { HttpClient, HttpRequest, HttpResponse } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  CodexRefreshError,
  parseChatgptIdentity,
  refreshCodexToken,
} from '../src/oauth/codex.js';

/** base64url-encode a string (no padding), matching JWT segment encoding. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Craft an unsigned id_token JWT carrying the codex auth claims. */
function craftIdToken(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.signature-not-verified`;
}

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

describe('refreshCodexToken', () => {
  it('posts a form-encoded refresh grant, rotates tokens, and computes expiresAt from now', async () => {
    const { http, calls } = fakeHttp({
      status: 200,
      ok: true,
      body: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      text: '',
    });

    const tokens = await refreshCodexToken(http, 'old-refresh', NOW);

    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('new-refresh');
    expect(tokens.idToken).toBe('new-id');
    expect(tokens.expiresAt.toISOString()).toBe('2026-06-17T01:00:00.000Z');

    expect(calls).toHaveLength(1);
    const [req] = calls;
    if (req === undefined) throw new Error('expected a recorded request');
    expect(req.method).toBe('POST');
    expect(req.url).toBe(CODEX_TOKEN_URL);
    expect(req.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    const body = String(req.body);
    expect(body).toContain(`client_id=${CODEX_CLIENT_ID}`);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=old-refresh');
    expect(body).toContain('scope=openid+profile+email');
  });

  it('keeps the input refresh token when the response omits a rotated one', async () => {
    const { http } = fakeHttp({
      status: 200,
      ok: true,
      body: { access_token: 'a', expires_in: 60 },
      text: '',
    });

    const tokens = await refreshCodexToken(http, 'sticky-refresh', NOW);
    expect(tokens.refreshToken).toBe('sticky-refresh');
    expect(tokens.expiresAt.toISOString()).toBe('2026-06-17T00:01:00.000Z');
  });

  it('throws a terminal CodexRefreshError when the body reports refresh_token_reused', async () => {
    const { http } = fakeHttp({
      status: 200,
      ok: false,
      body: { error: 'refresh_token_reused' },
      text: '{"error":"refresh_token_reused"}',
    });

    await expect(refreshCodexToken(http, 'dead', NOW)).rejects.toMatchObject({
      terminal: true,
    });
  });

  it('throws a terminal CodexRefreshError on HTTP 400/401', async () => {
    for (const status of [400, 401]) {
      const { http } = fakeHttp({ status, ok: false, body: undefined, text: 'invalid_grant' });
      const err = await refreshCodexToken(http, 'x', NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CodexRefreshError);
      expect((err as CodexRefreshError).terminal).toBe(true);
    }
  });

  it('throws a retryable (non-terminal) CodexRefreshError on HTTP 429', async () => {
    const { http } = fakeHttp({ status: 429, ok: false, body: undefined, text: 'rate limited' });
    const err = await refreshCodexToken(http, 'x', NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexRefreshError);
    expect((err as CodexRefreshError).terminal).toBe(false);
  });

  it('throws terminal for an unexpected non-ok status', async () => {
    const { http } = fakeHttp({ status: 500, ok: false, body: undefined, text: 'boom' });
    const err = await refreshCodexToken(http, 'x', NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexRefreshError);
    expect((err as CodexRefreshError).terminal).toBe(true);
  });
});

describe('parseChatgptIdentity', () => {
  it('extracts accountId, email, and plan from a crafted id_token JWT', () => {
    const idToken = craftIdToken({
      email: 'codex@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
        chatgpt_plan_type: 'plus',
      },
    });

    const identity = parseChatgptIdentity(idToken);
    expect(identity).toEqual({
      accountId: 'acct_123',
      email: 'codex@example.com',
      plan: 'plus',
    });
  });

  it('returns all-undefined fields when the auth claim is absent', () => {
    const idToken = craftIdToken({ sub: 'user-1' });
    expect(parseChatgptIdentity(idToken)).toEqual({});
  });

  it('returns an empty identity for garbage input without throwing', () => {
    expect(parseChatgptIdentity('not-a-jwt')).toEqual({});
    expect(parseChatgptIdentity('')).toEqual({});
    expect(parseChatgptIdentity('a.!!!notbase64!!!.c')).toEqual({});
    expect(parseChatgptIdentity('a.' + b64url('not json') + '.c')).toEqual({});
  });
});
