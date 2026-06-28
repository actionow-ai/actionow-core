import { createActionowClient } from '@actionow/sdk';

/**
 * The two clients a thin app backend holds — one per PLANE, because they carry
 * different credentials (see docs/INTEGRATION.md "auth cheat-sheet"):
 *
 *   - CONTROL PLANE (`/console/*`): a tenant-admin USER JWT, obtained once from
 *     `POST /auth/login` (email+password) and refreshed before expiry. Used to
 *     manage your end-users as core `subject`s and mint their data-plane keys.
 *     This credential is HIGH-TRUST and lives ONLY in your server — never ship it
 *     to a browser or a client app.
 *
 *   - DATA PLANE (`/v1/*`): a per-end-user `ak_…` API key minted on the control
 *     plane. Each end-user gets their own key so spend, governance limits, and
 *     job/file ownership are attributed to that subject. Your server makes the
 *     `/v1` call on the user's behalf with their key (or, for trusted native
 *     clients, hands the key out — your call).
 *
 * Money note: REQUEST bodies use human numbers; RESPONSE money is a µcredit
 * decimal STRING (parse with `BigInt`, never `Number`). 1 credit = 1e6 µcredit.
 */

export interface AppConfig {
  /** Core API origin, e.g. `https://gateway.example.com`. */
  baseUrl: string;
  /** Tenant-admin email for the console login. */
  consoleEmail: string;
  /** Tenant-admin password for the console login. */
  consolePassword: string;
}

/** A typed control-plane client authenticated with a tenant-admin USER JWT. */
export type ConsoleClient = ReturnType<typeof createActionowClient>;

/** A typed data-plane client authenticated with a subject-scoped `ak_…` key. */
export type DataPlaneClient = ReturnType<typeof createActionowClient>;

/**
 * Log in as the tenant admin and return a console client. The login itself is a
 * plain `fetch` because `/auth/login` is outside the generated OpenAPI surface
 * (it predates the contract-first SDK); everything AFTER login uses the typed
 * client or, for the handful of console routes not yet in the spec, `fetch`.
 */
export async function loginConsole(cfg: AppConfig): Promise<ConsoleClient> {
  const res = await fetch(`${cfg.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cfg.consoleEmail, password: cfg.consolePassword }),
  });
  if (!res.ok) {
    throw new Error(`console login failed: ${String(res.status)} ${await res.text()}`);
  }
  const { token } = (await res.json()) as { token: string };
  return createActionowClient({ baseUrl: cfg.baseUrl, token });
}

/** A data-plane client carrying a specific end-user's `ak_…` key. */
export function dataPlaneClient(baseUrl: string, apiKey: string): DataPlaneClient {
  return createActionowClient({ baseUrl, token: apiKey });
}
