import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineInvalidInput } from '../common/errors.js';
import type { AuthResult } from './local-auth.service.js';
import { LocalAuthService } from './local-auth.service.js';
import { LoginThrottleGuard } from './login-throttle.guard.js';

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
  constructor(private readonly auth: LocalAuthService) {}

  @Post('register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register a local user (provisions a tenant + account)' })
  async register(@Body() body: CredentialsBody): Promise<AuthResult> {
    return this.auth.register(parseRegistration(body));
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange email + password for a JWT' })
  async login(@Body() body: CredentialsBody): Promise<AuthResult> {
    return this.auth.login(parseCredentials(body));
  }

  @Post('register-member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register an end-user (member) under an existing tenant (G-F)' })
  async registerMember(@Body() body: MemberBody): Promise<AuthResult> {
    return this.auth.registerMember({ ...parseRegistration(body), tenantId: parseTenantId(body) });
  }

  @Post('login-member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a tenant + email + password for a member JWT' })
  async loginMember(@Body() body: MemberBody): Promise<AuthResult> {
    return this.auth.loginMember({ ...parseCredentials(body), tenantId: parseTenantId(body) });
  }
}
