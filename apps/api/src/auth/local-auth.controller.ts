import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { engineInvalidInput } from '../common/errors.js';
import type { AuthResult } from './local-auth.service.js';
import { LocalAuthService } from './local-auth.service.js';
import { LoginThrottleGuard } from './login-throttle.guard.js';
import type { SessionReqMeta, TokenPair } from './session.service.js';
import { SessionService } from './session.service.js';

/** Minimum/maximum password length enforced at registration (the max bounds scrypt cost). */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

/** The `POST /auth/register` and `/auth/login` request body. */
interface CredentialsBody {
  email?: unknown;
  password?: unknown;
}

/** The member (end-user) auth body — credentials PLUS the tenant to scope to. */
interface MemberBody extends CredentialsBody {
  tenantId?: unknown;
}

/** Validate a required `tenantId` string, or throw `invalid_input`. */
function parseTenantId(body: MemberBody): string {
  const { tenantId } = body;
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw engineInvalidInput('tenantId is required');
  }
  return tenantId;
}

/** The `{ refreshToken }` body shared by `/auth/refresh` and `/auth/logout`. */
interface RefreshBody {
  refreshToken?: unknown;
}

/** Validate a required `refreshToken` string, or throw `invalid_input`. */
function parseRefreshToken(body: RefreshBody): string {
  const { refreshToken } = body;
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw engineInvalidInput('refreshToken is required');
  }
  return refreshToken;
}

/** Best-effort UA/IP capture for the session row (both nullable). */
function reqMeta(req: Request): SessionReqMeta {
  const ua = req.headers['user-agent'];
  return {
    userAgent: typeof ua === 'string' ? ua : null,
    ip: typeof req.ip === 'string' ? req.ip : null,
  };
}

/** Validate the shared `{email, password}` body shape, or throw `invalid_input`. */
function parseCredentials(body: CredentialsBody): { email: string; password: string } {
  const { email, password } = body;
  if (
    typeof email !== 'string' ||
    email === '' ||
    typeof password !== 'string' ||
    password === ''
  ) {
    throw engineInvalidInput('email and password are required');
  }
  return { email, password };
}

/**
 * Registration credentials: shape check PLUS a password-strength floor. Enforced
 * only at registration (not login) so existing accounts aren't locked out, and
 * so the response to a too-weak password is a clear 400 rather than a 401.
 */
function parseRegistration(body: CredentialsBody): { email: string; password: string } {
  const creds = parseCredentials(body);
  if (creds.password.length < MIN_PASSWORD_LENGTH || creds.password.length > MAX_PASSWORD_LENGTH) {
    throw engineInvalidInput(
      `password must be ${String(MIN_PASSWORD_LENGTH)}-${String(MAX_PASSWORD_LENGTH)} characters`,
    );
  }
  return creds;
}

/**
 * Unified local auth (Phase 9). `POST /auth/register` provisions a tenant +
 * account for a brand-new user and returns a JWT; `POST /auth/login` exchanges
 * credentials for a JWT. A malformed body is `400 invalid_input`; a duplicate
 * registration is `400 invalid_input`; bad login credentials are `401
 * unauthorized` (uniform, via the service + {@link UnifiedErrorFilter}).
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(LoginThrottleGuard)
export class LocalAuthController {
  constructor(
    private readonly auth: LocalAuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register a local user (provisions a tenant + account)' })
  async register(@Body() body: CredentialsBody, @Req() req: Request): Promise<AuthResult> {
    return this.auth.register(parseRegistration(body), reqMeta(req));
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange email + password for an access + refresh token pair' })
  async login(@Body() body: CredentialsBody, @Req() req: Request): Promise<AuthResult> {
    return this.auth.login(parseCredentials(body), reqMeta(req));
  }

  @Post('register-member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register an end-user (member) under an existing tenant (G-F)' })
  async registerMember(@Body() body: MemberBody, @Req() req: Request): Promise<AuthResult> {
    return this.auth.registerMember(
      { ...parseRegistration(body), tenantId: parseTenantId(body) },
      reqMeta(req),
    );
  }

  @Post('login-member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a tenant + email + password for a member token pair' })
  async loginMember(@Body() body: MemberBody, @Req() req: Request): Promise<AuthResult> {
    return this.auth.loginMember(
      { ...parseCredentials(body), tenantId: parseTenantId(body) },
      reqMeta(req),
    );
  }

  /**
   * Rotate a refresh token: return a fresh `{token, accessToken, refreshToken,
   * expiresIn}` and revoke the presented one. Typ-aware via the session row's
   * `principal_kind` (a member refresh re-mints `typ:'subject'` + tenant_id; an
   * operator/admin refresh re-mints `{sub, role}`). A reused (already-rotated)
   * refresh revokes the whole family + 401 (theft detection). Admin refresh reuses
   * this same endpoint — no separate admin route.
   */
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token (returns a new access + refresh pair)' })
  async refresh(@Body() body: RefreshBody, @Req() req: Request): Promise<TokenPair> {
    return this.sessions.refresh(parseRefreshToken(body), reqMeta(req));
  }

  /** Revoke the session behind a refresh token (logout). Idempotent: 204 always. */
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token (logout)' })
  async logout(@Body() body: RefreshBody): Promise<void> {
    await this.sessions.logout(parseRefreshToken(body));
  }
}
