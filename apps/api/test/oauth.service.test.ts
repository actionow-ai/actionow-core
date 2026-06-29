import type { Database, LinkIdentityInput, UserRecord } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { LocalAuthService } from '../src/auth/local-auth.service.js';
import type { OauthProfile, OauthRepo, ProfileResolver } from '../src/auth/oauth.service.js';
import { OauthService } from '../src/auth/oauth.service.js';
import type { SessionService, TokenPair } from '../src/auth/session.service.js';
import { TokenIssuerService } from '../src/auth/token-issuer.service.js';

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

describe('OauthService.callback self-register (rbac)', () => {
  it('a brand-new oauth user becomes its tenant admin (tenant_role=admin)', async () => {
    const linkInputs: LinkIdentityInput[] = [];
    const repo: OauthRepo = {
      findUserByIdentity: () => Promise.resolve(undefined),
      findUserByEmail: () => Promise.resolve(undefined),
      createUserIdentity: () => Promise.resolve({ id: 'ident-1' }),
      linkIdentityTx: (_db: Database, input: LinkIdentityInput): Promise<UserRecord> => {
        linkInputs.push(input);
        const user: UserRecord = {
          id: 'user-1',
          email: input.email,
          emailVerified: input.emailVerified ?? false,
          passwordHash: null,
          role: input.role ?? 'user',
          tenantRole: input.tenantRole ?? null,
          status: 'active',
          tenantId: input.tenantId ?? null,
          createdAt: new Date(),
        };
        return Promise.resolve(user);
      },
      createTenant: () => Promise.resolve({ id: 'tenant-1' }),
      createAccount: () => Promise.resolve({ id: 'acct-1' }),
    };
    const profile: OauthProfile = {
      providerUserId: 'gh-123',
      email: 'new@example.com',
      emailVerified: true,
    };
    const resolver: ProfileResolver = () => Promise.resolve(profile);
    const issuer = new TokenIssuerService(
      { ADMIN_JWT_SECRET: 'test-secret', JWT_SIGNING_ALG: 'HS256', JWT_ACCESS_TTL: '12h' } as never,
      new JwtService({ secret: 'test-secret' }),
      null,
    );
    // A stub SessionService that wraps the access token without touching the db.
    const fakeSessions = {
      createForPrincipal: (_p: unknown, accessToken: string): Promise<TokenPair> =>
        Promise.resolve({
          token: accessToken,
          accessToken,
          refreshToken: 'rt_x',
          expiresIn: '12h',
        }),
    } as unknown as SessionService;
    const localAuth = new LocalAuthService({} as Database, {} as never, issuer, fakeSessions);
    const svc = new OauthService({} as Database, ENV_WITH_PROVIDERS, localAuth, repo, resolver);

    const { token } = await svc.callback('github', 'auth-code');
    expect(token).toBeTypeOf('string');
    expect(linkInputs).toHaveLength(1);
    expect(linkInputs[0]?.role).toBe('user');
    expect(linkInputs[0]?.tenantRole).toBe('admin');
    expect(linkInputs[0]?.tenantId).toBe('tenant-1');
  });
});
