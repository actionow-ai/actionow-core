import type {
  CreateUserIdentityInput,
  Database,
  LinkIdentityInput,
  UserRecord,
} from '@actionow/db';
import {
  createAccount,
  createTenant,
  createUserIdentity,
  findUserByEmail,
  findUserByIdentity,
  linkIdentityTx,
} from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import { decodeIdToken, generateCodeVerifier, generateState, GitHub, Google } from 'arctic';

import { engineInvalidInput } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';
import type { AuthResult } from './local-auth.service.js';
import { LocalAuthService } from './local-auth.service.js';

/** The OAuth providers this service speaks. */
export type OauthProvider = 'google' | 'github';

/** The two providers, used to validate the `:provider` route param. */
const PROVIDERS: readonly OauthProvider[] = ['google', 'github'];

/** The provider-agnostic identity resolved from a completed OAuth exchange. */
export interface OauthProfile {
  /** The provider's stable subject id — what `(provider, sub)` keys on. */
  readonly providerUserId: string;
  /** The account email, if the provider released one. */
  readonly email: string | null;
  /** Whether the provider asserts that email is verified. */
  readonly emailVerified: boolean;
}

/** What {@link OauthService.start} returns to the controller (cookies + redirect). */
export interface OauthStart {
  /** The provider authorization URL to 302-redirect the browser to. */
  readonly url: string;
  /** CSRF state to stash in a cookie and re-assert on callback. */
  readonly state: string;
  /** PKCE verifier (Google only) to stash in a cookie; `undefined` for GitHub. */
  readonly codeVerifier?: string;
}

/**
 * Resolves a provider profile from an authorization `code`. Injected so e2e
 * tests can drive a full callback without real network (the default exchanges
 * the code via `arctic`, whose token request + the GitHub profile fetch both go
 * through the global `fetch` the tests stub).
 */
export type ProfileResolver = (
  provider: OauthProvider,
  google: Google,
  github: GitHub,
  code: string,
  codeVerifier: string | undefined,
) => Promise<OauthProfile>;

/**
 * The db surface OAuth depends on, extracted so unit tests inject a fake repo.
 * Mirrors the `@actionow/db` function signatures.
 */
export interface OauthRepo {
  findUserByIdentity(
    db: Database,
    provider: string,
    providerUserId: string,
  ): Promise<UserRecord | undefined>;
  findUserByEmail(db: Database, email: string): Promise<UserRecord | undefined>;
  createUserIdentity(db: Database, input: CreateUserIdentityInput): Promise<{ id: string }>;
  linkIdentityTx(db: Database, input: LinkIdentityInput): Promise<UserRecord>;
  createTenant(db: Database, input: { name: string }): Promise<{ id: string }>;
  createAccount(db: Database, input: { tenantId: string }): Promise<{ id: string }>;
}

/** Production repo wired to the real `@actionow/db` functions. */
export const defaultOauthRepo: OauthRepo = {
  findUserByIdentity,
  findUserByEmail,
  createUserIdentity,
  linkIdentityTx,
  createTenant: (db, input) => createTenant(db, input),
  createAccount: (db, input) => createAccount(db, input),
};

/** DI token for the (overridable) {@link OauthRepo}. */
export const OAUTH_REPO = Symbol('OAUTH_REPO');

/** DI token for the (overridable) {@link ProfileResolver}. */
export const PROFILE_RESOLVER = Symbol('PROFILE_RESOLVER');

/** Narrow an unknown JSON value to a non-null record for typed field access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read a required string field from decoded JSON, or throw `invalid_input`. */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && value !== '') return value;
  // `sub` can also arrive as a number (GitHub `id`); coerce defensively.
  if (typeof value === 'number') return String(value);
  throw engineInvalidInput(`oauth profile missing ${key}`);
}

/** Decode a Google id_token into `{providerUserId, email, emailVerified}`. */
function googleProfile(idToken: string): OauthProfile {
  const claims: unknown = decodeIdToken(idToken);
  if (!isRecord(claims)) throw engineInvalidInput('invalid google id_token');
  return {
    providerUserId: requireString(claims, 'sub'),
    email: typeof claims.email === 'string' ? claims.email : null,
    emailVerified: claims.email_verified === true,
  };
}

/** The GitHub `/user` and `/user/emails` shapes we read (typed-guarded). */
interface GithubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

/** Pick the primary, verified email from GitHub's `/user/emails` list. */
function pickGithubEmail(emails: unknown): { email: string; emailVerified: boolean } {
  if (!Array.isArray(emails)) return { email: '', emailVerified: false };
  for (const entry of emails) {
    if (
      isRecord(entry) &&
      typeof entry.email === 'string' &&
      entry.primary === true &&
      entry.verified === true
    ) {
      const e: GithubEmail = { email: entry.email, primary: true, verified: true };
      return { email: e.email, emailVerified: true };
    }
  }
  return { email: '', emailVerified: false };
}

/**
 * Default resolver: exchange the code via arctic, then resolve the profile.
 * Google decodes the id_token; GitHub fetches `/user` (+ `/user/emails`). Both
 * the token request and the GitHub fetches use the global `fetch` tests stub.
 */
const defaultProfileResolver: ProfileResolver = async (
  provider,
  google,
  github,
  code,
  codeVerifier,
) => {
  if (provider === 'google') {
    const tokens = await google.validateAuthorizationCode(code, codeVerifier ?? '');
    return googleProfile(tokens.idToken());
  }
  const tokens = await github.validateAuthorizationCode(code);
  const accessToken = tokens.accessToken();
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'actionow',
  };
  const userRes = await fetch('https://api.github.com/user', { headers });
  const userJson: unknown = await userRes.json();
  if (!isRecord(userJson)) throw engineInvalidInput('invalid github user response');
  const providerUserId = requireString(userJson, 'id');

  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  const emailsJson: unknown = await emailsRes.json();
  const { email, emailVerified } = pickGithubEmail(emailsJson);
  return { providerUserId, email: email === '' ? null : email, emailVerified };
};

/**
 * Google/GitHub OAuth (Phase 9) via `arctic`, keyed on `(provider, sub)` —
 * never email. `start` builds the authorization URL (Google with OIDC+PKCE,
 * GitHub with state); `callback` exchanges the code and find-or-creates the
 * user; `link` attaches a provider identity to an already-authenticated user.
 *
 * Find-or-create on callback:
 *  - `(provider, sub)` already linked → log that user in.
 *  - else a VERIFIED provider email matching an existing VERIFIED `user.email`
 *    → auto-link the identity to that user (account-takeover-safe).
 *  - else a lightweight register: a password-less user (one tx with its first
 *    identity + a fresh tenant/account), `email_verified` = the provider flag.
 *
 * Tokens, codes, id_tokens, and secrets are never logged.
 */
@Injectable()
export class OauthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly localAuth: LocalAuthService,
    @Inject(OAUTH_REPO) private readonly repo: OauthRepo,
    @Inject(PROFILE_RESOLVER) private readonly resolveProfile: ProfileResolver,
  ) {}

  /**
   * Begin a login: validate the provider, generate a CSRF `state` (+ a PKCE
   * verifier for Google), and build the provider authorization URL. The caller
   * stores `state`/`codeVerifier` in short-lived cookies and 302-redirects.
   */
  start(provider: string): OauthStart {
    const p = this.parseProvider(provider);
    const state = generateState();
    if (p === 'google') {
      const codeVerifier = generateCodeVerifier();
      const url = this.google().createAuthorizationURL(state, codeVerifier, [
        'openid',
        'profile',
        'email',
      ]);
      return { url: url.toString(), state, codeVerifier };
    }
    const url = this.github().createAuthorizationURL(state, ['read:user', 'user:email']);
    return { url: url.toString(), state };
  }

  /**
   * Complete a login: exchange the `code` for a profile, then find-or-create the
   * user (see the class doc) and issue a JWT. The CSRF `state` is verified by the
   * controller against the cookie before this runs.
   */
  async callback(provider: string, code: string, codeVerifier?: string): Promise<AuthResult> {
    const p = this.parseProvider(provider);
    const profile = await this.resolveProfile(p, this.google(), this.github(), code, codeVerifier);
    const user = await this.findOrCreate(p, profile);
    return this.localAuth.issueToken(user);
  }

  /**
   * Attach a provider identity to the already-authenticated `currentUserId`.
   * Rejects (with `invalid_input`) when that `(provider, sub)` already links a
   * DIFFERENT user — an identity belongs to exactly one account.
   */
  async link(
    provider: string,
    code: string,
    codeVerifier: string | undefined,
    currentUserId: string,
  ): Promise<void> {
    const p = this.parseProvider(provider);
    const profile = await this.resolveProfile(p, this.google(), this.github(), code, codeVerifier);

    const existing = await this.repo.findUserByIdentity(this.db, p, profile.providerUserId);
    if (existing !== undefined) {
      if (existing.id === currentUserId) return; // already linked to this user — idempotent.
      throw engineInvalidInput('this identity is already linked to another account');
    }
    await this.repo.createUserIdentity(this.db, {
      userId: currentUserId,
      provider: p,
      providerUserId: profile.providerUserId,
    });
  }

  /** Find-or-create the user behind a resolved profile (see class doc). */
  private async findOrCreate(provider: OauthProvider, profile: OauthProfile): Promise<UserRecord> {
    const linked = await this.repo.findUserByIdentity(this.db, provider, profile.providerUserId);
    if (linked !== undefined) return linked;

    // Look the provider email up once (when present) to drive both the auto-link
    // decision and whether the new account may claim that email as canonical.
    const byEmail =
      profile.email !== null ? await this.repo.findUserByEmail(this.db, profile.email) : undefined;

    // Auto-link ONLY when the provider email is verified AND matches an existing
    // user whose own email is verified — never link on an unverified email.
    if (profile.emailVerified && byEmail?.emailVerified === true) {
      await this.repo.createUserIdentity(this.db, {
        userId: byEmail.id,
        provider,
        providerUserId: profile.providerUserId,
      });
      return byEmail;
    }

    // Lightweight register: a password-less user with its first identity + a
    // fresh tenant/account, all in one tx. The new account claims the provider
    // email as its canonical email ONLY when that email is verified AND not
    // already taken — otherwise it gets a synthetic, collision-free address
    // (an unverified or already-used email must never squat the unique index).
    const canClaimEmail = profile.email !== null && profile.emailVerified && byEmail === undefined;
    const email = canClaimEmail
      ? profile.email
      : `${provider}-${profile.providerUserId}@oauth.local`;
    const tenant = await this.repo.createTenant(this.db, {
      name: `oauth-${provider}-${profile.providerUserId}`,
    });
    await this.repo.createAccount(this.db, { tenantId: tenant.id });
    return this.repo.linkIdentityTx(this.db, {
      email,
      passwordHash: null,
      role: 'user',
      emailVerified: canClaimEmail,
      tenantId: tenant.id,
      provider,
      providerUserId: profile.providerUserId,
    });
  }

  /** Validate the `:provider` route param, or throw `invalid_input`. */
  private parseProvider(provider: string): OauthProvider {
    if ((PROVIDERS as readonly string[]).includes(provider)) return provider as OauthProvider;
    throw engineInvalidInput('unknown oauth provider');
  }

  /** Build the arctic Google client, or throw if its creds are unset. */
  private google(): Google {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = this.env;
    if (GOOGLE_CLIENT_ID === undefined || GOOGLE_CLIENT_SECRET === undefined) {
      throw engineInvalidInput('google oauth is not configured');
    }
    return new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, this.redirectUri('google'));
  }

  /** Build the arctic GitHub client, or throw if its creds are unset. */
  private github(): GitHub {
    const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = this.env;
    if (GITHUB_CLIENT_ID === undefined || GITHUB_CLIENT_SECRET === undefined) {
      throw engineInvalidInput('github oauth is not configured');
    }
    return new GitHub(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, this.redirectUri('github'));
  }

  /** The exact registered redirect URI for a provider (`<base>/<path>`). */
  private redirectUri(provider: OauthProvider): string {
    const base = this.env.OAUTH_REDIRECT_BASE;
    if (base === undefined) throw engineInvalidInput('OAUTH_REDIRECT_BASE is not configured');
    return `${base.replace(/\/$/, '')}/auth/oauth/${provider}/callback`;
  }
}

export { defaultProfileResolver };
