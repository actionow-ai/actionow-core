import { rawPost } from './client.js';

export interface TokenPair {
  token: string; // back-compat alias of accessToken
  accessToken: string;
  refreshToken: string;
  expiresIn: string; // a DURATION STRING like '12h' — NOT seconds; don't do arithmetic on it
}

export function loginConsole(baseUrl: string, email: string, password: string): Promise<TokenPair> {
  return rawPost<TokenPair>(baseUrl, '/auth/login', { email, password });
}

export function refreshTokens(baseUrl: string, refreshToken: string): Promise<TokenPair> {
  return rawPost<TokenPair>(baseUrl, '/auth/refresh', { refreshToken });
}

function jwtExpMs(jwt: string): number {
  try {
    const payload = jwt.split('.')[1] ?? '';
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return exp ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Lazy tenant-admin session: logs in once, then refreshes ~60s before the JWT
 * `exp`. Tracks expiry from the token's `exp` claim because `expiresIn` is a
 * duration string, not a number.
 */
export class ConsoleSession {
  private pair?: TokenPair;
  private expMs = 0;

  constructor(
    private baseUrl: string,
    private email: string,
    private password: string,
  ) {}

  async token(): Promise<string> {
    if (!this.pair) {
      this.pair = await loginConsole(this.baseUrl, this.email, this.password);
    } else if (Date.now() > this.expMs - 60_000) {
      this.pair = await refreshTokens(this.baseUrl, this.pair.refreshToken).catch(() =>
        loginConsole(this.baseUrl, this.email, this.password),
      );
    }
    this.expMs = jwtExpMs(this.pair.accessToken);
    return this.pair.token;
  }
}
