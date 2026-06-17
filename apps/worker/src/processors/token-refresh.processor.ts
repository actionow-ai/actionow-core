import type { HttpClient } from '@actionow/contracts';
import {
  claimRefreshLock,
  getDecryptedOAuthSession,
  listRefreshableSessions,
  markNeedsReauth,
  updateOAuthTokens,
} from '@actionow/db';
import { CODEX_REFRESH_LEAD_MS, CodexRefreshError, refreshCodexToken } from '@actionow/engine';

import type { WorkerRuntime } from '../runtime.js';

/** The rotated token set a per-kind refresh yields (shape shared across kinds). */
interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Dispatch a refresh by provider kind. `codex-oauth` POSTs the refresh-token
 * grant to the codex token endpoint; an unknown kind throws (a terminal,
 * never-retryable misconfiguration). Tokens are returned, never logged.
 */
function refreshForKind(
  kind: string,
  http: HttpClient,
  refreshToken: string,
  now: Date,
): Promise<RefreshedTokens> {
  if (kind === 'codex-oauth') return refreshCodexToken(http, refreshToken, now);
  throw new CodexRefreshError(`unknown oauth provider kind: ${kind}`, true);
}

/**
 * Build the `token-refresh` processor: a repeatable sweep (~every 60s) that
 * proactively refreshes near-expiry `oauth_session` rows so a relay request
 * never stalls on a refresh. For each due session it takes the DB singleflight
 * lock (`claimRefreshLock`) — skipping any another sweep/instance holds —
 * decrypts the refresh token, dispatches by provider kind, and rotates the
 * stored tokens (which also clears the lock). A terminal refresh failure (dead
 * refresh token) marks the session `needs_reauth`; a transient failure (e.g.
 * HTTP 429) leaves the lock to expire so the next sweep retries.
 *
 * Pure over the injected runtime; returns the count of sessions refreshed.
 * A per-session error is caught so one bad session can never crash the sweep,
 * and tokens are never logged.
 */
export function createTokenRefreshProcessor(runtime: WorkerRuntime): () => Promise<number> {
  return async (): Promise<number> => {
    const keyB64 = runtime.env.SECRET_ENCRYPTION_KEY;
    if (keyB64 === undefined || keyB64 === '') return 0; // no master key → nothing to refresh
    const now = new Date();
    const due = await listRefreshableSessions(runtime.db, now, CODEX_REFRESH_LEAD_MS);
    let refreshed = 0;
    for (const s of due) {
      // Someone else (another sweep tick / worker instance) holds a live lock.
      if (!(await claimRefreshLock(runtime.db, s.secretRefId, now))) continue;
      try {
        const session = await getDecryptedOAuthSession(runtime.db, s.secretRefId, keyB64);
        if (session === undefined) continue;
        // SECURITY: `runtime.http` MUST stay an untraced FetchHttpClient — the refresh
        // response carries rotated access/refresh tokens; routing it through a
        // RELAY_TRACE-wrapped client would persist those tokens at rest in relay_trace.
        const next = await refreshForKind(s.providerKind, runtime.http, session.refreshToken, now);
        await updateOAuthTokens(runtime.db, s.secretRefId, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: next.expiresAt,
          keyB64,
          now,
        });
        refreshed += 1;
      } catch (err) {
        if (err instanceof CodexRefreshError && err.terminal) {
          // Dead refresh token: stop attempting until the operator re-auths.
          await markNeedsReauth(runtime.db, s.secretRefId);
        }
        // Transient (e.g. 429) or unexpected: leave the lock to expire; the next
        // sweep retries. Never log the token; never crash the whole sweep.
      }
    }
    return refreshed;
  };
}
