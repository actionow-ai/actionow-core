import { AdapterError } from '@actionow/adapters';
import type { HttpClient, HttpRequest, UnifiedErrorCode } from '@actionow/contracts';

/**
 * The engine-facing fault-tolerance policy resolved from a `fault_policy` row
 * (the API loader maps the DB row → this and attaches it to a {@link RunChannel}).
 * Governs ONE channel's per-attempt resilience: same-channel retry + backoff +
 * per-attempt timeouts + retry triggers. Absent on a channel → engine defaults
 * (a single attempt + client-wide timeouts).
 */
export interface FaultPolicy {
  /** Surface the first error immediately (no same-channel retry). */
  fastFail: boolean;
  /** SAME-channel retry attempts after the first failure (0 = none). */
  retryCount: number;
  backoffType: 'fixed' | 'exponential';
  /** Base backoff interval (ms); exponential doubles it per retry. */
  backoffMs: number;
  /** Per-attempt timeouts (ms); undefined → client default. */
  connectTimeoutMs?: number | undefined;
  ttftTimeoutMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  /** HTTP status codes that TRIGGER a same-channel retry; empty → adapter default verdict. */
  retryCodes?: number[] | undefined;
  /** Error-message substrings that trigger a same-channel retry; empty → adapter default. */
  retryMessages?: string[] | undefined;
}

/** Injectable clock for the retry backoff (real `setTimeout` in prod; fake in tests). */
export interface FaultPolicyClock {
  sleep: (ms: number) => Promise<void>;
}

const realClock: FaultPolicyClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Wrap an {@link HttpClient} so every request inherits the policy's per-attempt
 * timeouts (only filling fields the caller left unset). Returns the client
 * UNCHANGED when the policy is absent or sets no timeouts, and preserves the
 * optional `stream` method's presence (so streaming-capability checks still
 * work). The four timeouts map to {@link HttpRequest} fields:
 * - `totalTimeoutMs` → `timeoutMs` (whole buffered request)
 * - `connectTimeoutMs` → `connectTimeoutMs` (curl-enforced; fetch best-effort)
 * - `ttftTimeoutMs` → `firstChunkTimeoutMs` (stream time-to-first-token)
 * - `idleTimeoutMs` → `idleTimeoutMs` (stream inter-chunk idle)
 */
export function wrapHttpWithTimeouts(
  http: HttpClient,
  policy: FaultPolicy | undefined,
): HttpClient {
  if (policy === undefined) return http;
  const { connectTimeoutMs, ttftTimeoutMs, totalTimeoutMs, idleTimeoutMs } = policy;
  if (
    connectTimeoutMs === undefined &&
    ttftTimeoutMs === undefined &&
    totalTimeoutMs === undefined &&
    idleTimeoutMs === undefined
  ) {
    return http;
  }
  const apply = (req: HttpRequest): HttpRequest => {
    const out: HttpRequest = { ...req };
    if (totalTimeoutMs !== undefined && out.timeoutMs === undefined) out.timeoutMs = totalTimeoutMs;
    if (connectTimeoutMs !== undefined && out.connectTimeoutMs === undefined) {
      out.connectTimeoutMs = connectTimeoutMs;
    }
    if (idleTimeoutMs !== undefined && out.idleTimeoutMs === undefined) {
      out.idleTimeoutMs = idleTimeoutMs;
    }
    if (ttftTimeoutMs !== undefined && out.firstChunkTimeoutMs === undefined) {
      out.firstChunkTimeoutMs = ttftTimeoutMs;
    }
    return out;
  };
  const wrapped: HttpClient = { request: (req) => http.request(apply(req)) };
  const innerStream = http.stream?.bind(http);
  if (innerStream !== undefined) wrapped.stream = (req) => innerStream(apply(req));
  return wrapped;
}

/** Mirror of `httpStatusToUnified`: the {@link UnifiedErrorCode} an HTTP status maps to. */
function unifiedForHttpStatus(status: number): UnifiedErrorCode {
  if (status === 400) return 'invalid_input';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'resource_not_found';
  if (status === 408) return 'upstream_timeout';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
}

/**
 * Whether an error should trigger a SAME-channel retry under this policy.
 *
 * - `fastFail` or `retryCount <= 0` → never.
 * - No triggers configured (`retryCodes`/`retryMessages` both empty) → fall back
 *   to the adapter's built-in retryable verdict (an {@link AdapterError}'s
 *   `unified.retryable`; a raw non-adapter error is treated as retryable since a
 *   transport throw is transient).
 * - Triggers configured → retry ONLY when the error matches: its mapped unified
 *   code equals one of `retryCodes` (HTTP→unified), OR its message/rawCode
 *   contains one of `retryMessages` (case-insensitive substring).
 */
export function shouldRetrySameChannel(err: unknown, policy: FaultPolicy): boolean {
  if (policy.fastFail || policy.retryCount <= 0) return false;
  const codes = policy.retryCodes ?? [];
  const msgs = policy.retryMessages ?? [];
  if (codes.length === 0 && msgs.length === 0) {
    return err instanceof AdapterError ? err.unified.retryable : err instanceof Error;
  }
  const unified = err instanceof AdapterError ? err.unified : undefined;
  if (unified !== undefined && codes.some((c) => unifiedForHttpStatus(c) === unified.code)) {
    return true;
  }
  if (msgs.length > 0) {
    const haystack = (
      (unified?.message ?? (err instanceof Error ? err.message : String(err))) +
      ' ' +
      (unified?.upstream?.rawCode ?? '')
    ).toLowerCase();
    if (msgs.some((m) => haystack.includes(m.toLowerCase()))) return true;
  }
  return false;
}

/** Backoff delay (ms) before the `attemptIndex`-th retry (1-based): fixed or exponential. */
function backoffMsFor(policy: FaultPolicy, attemptIndex: number): number {
  if (policy.backoffMs <= 0) return 0;
  return policy.backoffType === 'exponential'
    ? policy.backoffMs * 2 ** (attemptIndex - 1)
    : policy.backoffMs;
}

/**
 * Run `attempt` under a channel's {@link FaultPolicy}: on a retryable failure
 * (per {@link shouldRetrySameChannel}) re-run the SAME attempt up to
 * `retryCount` extra times, spaced by the configured backoff, before giving up
 * and rethrowing the last error (which the cross-channel failover then handles).
 *
 * A `null`/`undefined` policy runs `attempt` exactly once (today's behavior).
 */
export async function runWithFaultPolicy<R>(
  policy: FaultPolicy | undefined,
  attempt: () => Promise<R>,
  clock: FaultPolicyClock = realClock,
): Promise<R> {
  if (policy === undefined) return attempt();
  const maxAttempts = policy.fastFail ? 1 : 1 + Math.max(0, policy.retryCount);
  let lastError: unknown;
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i >= maxAttempts) throw err;
      if (!shouldRetrySameChannel(err, policy)) throw err;
      const delay = backoffMsFor(policy, i);
      if (delay > 0) await clock.sleep(delay);
    }
  }
  throw lastError;
}
