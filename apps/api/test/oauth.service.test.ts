import type { AppEnv } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import { OauthService } from '../src/auth/oauth.service.js';

/** A minimal env with both providers configured, for the `start` URL assertions. */
const ENV_WITH_PROVIDERS = {
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GITHUB_CLIENT_ID: 'github-client-id',
  GITHUB_CLIENT_SECRET: 'github-client-secret',
  OAUTH_REDIRECT_BASE: 'http://localhost:3000',
} as unknown as AppEnv;

/** An env with NO provider creds — every OAuth route must `invalid_input`. */
const ENV_NO_PROVIDERS = {} as unknown as AppEnv;

/** Build a service that never touches the db (the `start` path doesn't). */
function service(env: AppEnv): OauthService {
  return new OauthService(
    {} as never, // db — unused by `start`
    env,
    {} as never, // LocalAuthService — unused by `start`
    {} as never, // repo — unused by `start`
    () => Promise.reject(new Error('profile resolver not used in start tests')),
  );
}

describe('OauthService.start', () => {
  it('builds a Google authorize URL with PKCE challenge + openid/profile/email scopes', () => {
    const { url, state, codeVerifier } = service(ENV_WITH_PROVIDERS).start('google');

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('google-client-id');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe(state);
    // PKCE: a S256 code_challenge is present (we keep the verifier in a cookie).
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(codeVerifier).toBeTypeOf('string');
    const scopes = (parsed.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('profile');
    expect(scopes).toContain('email');
    // The redirect_uri is the configured base + the provider callback path.
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/auth/oauth/google/callback',
    );
  });

  it('builds a GitHub authorize URL with state + read:user/user:email scopes (no PKCE)', () => {
    const result = service(ENV_WITH_PROVIDERS).start('github');

    const parsed = new URL(result.url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('github-client-id');
    expect(parsed.searchParams.get('state')).toBe(result.state);
    const scopes = (parsed.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('read:user');
    expect(scopes).toContain('user:email');
    // GitHub OAuth2 has no PKCE — no verifier returned.
    expect(result.codeVerifier).toBeUndefined();
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/auth/oauth/github/callback',
    );
  });

  it('rejects an unknown provider with invalid_input', () => {
    expect(() => service(ENV_WITH_PROVIDERS).start('facebook')).toThrowError(
      /unknown oauth provider/i,
    );
  });

  it('rejects a provider whose creds are unset with invalid_input (no crash)', () => {
    expect(() => service(ENV_NO_PROVIDERS).start('google')).toThrowError(/not configured/i);
    expect(() => service(ENV_NO_PROVIDERS).start('github')).toThrowError(/not configured/i);
  });
});
