import { createHmac } from 'node:crypto';

import type { HttpClient } from '@actionow/contracts';
import {
  type DbOrTx,
  listDueWebhooks,
  markWebhookDead,
  markWebhookSent,
  rescheduleWebhook,
} from '@actionow/db';
import { assertEgressAllowed } from '@actionow/infra';

/** The header carrying the HMAC-SHA256 hex signature of the webhook body. */
export const SIGNATURE_HEADER = 'X-Actionow-Signature';

/**
 * Sign a webhook body with HMAC-SHA256, returning the lowercase hex digest.
 * The receiver recomputes the same digest over the raw body to verify
 * authenticity. The `secret` is never logged or returned.
 */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export interface WebhookDispatcherOptions {
  /** Max delivery attempts before a row is dead-lettered (default 5). */
  maxAttempts?: number;
  /** Base backoff in ms; the delay is `base * 2^(attempts-1)` (default 1000). */
  backoffBaseMs?: number;
  /** Cap on a single backoff delay in ms (default 1h). */
  backoffMaxMs?: number;
  /** Rows processed per `dispatchDue` call (default 50). */
  batchSize?: number;
  /** Resolve the signing secret per webhook url; absent → unsigned. */
  resolveSecret?: (url: string) => Promise<string | undefined>;
  /**
   * SSRF egress guard for the (tenant-controlled) callback url; rejects by
   * throwing. Default: infra's {@link assertEgressAllowed} with the strict
   * policy (private/loopback/link-local/reserved targets and non-http schemes
   * are blocked). The worker injects one bound to `WEBHOOK_ALLOW_PRIVATE_TARGETS`.
   */
  assertEgressAllowed?: (url: string) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60_000;
const DEFAULT_BATCH_SIZE = 50;

export interface DispatchSummary {
  processed: number;
  sent: number;
  retried: number;
  dead: number;
}

/** Exponential backoff delay for the n-th attempt (1-based), capped. */
export function backoffMs(attempts: number, baseMs: number, maxMs: number): number {
  const exp = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, maxMs);
}

/**
 * Drains the `webhook_outbox` (§4.2): for each due row, POSTs the stored
 * payload with the HMAC signature header. On a 2xx the row is `sent`; on
 * failure `attempts` is bumped and the row is rescheduled with exponential
 * backoff, transitioning to `dead` once the attempt budget is exhausted.
 *
 * Webhook delivery never touches the money path — a permanently failing hook
 * only dead-letters; the ledger is already correct (review #11).
 */
export class WebhookDispatcher {
  private readonly opts: Required<
    Omit<WebhookDispatcherOptions, 'resolveSecret' | 'assertEgressAllowed'>
  > &
    Pick<WebhookDispatcherOptions, 'resolveSecret'>;

  /** SSRF egress guard; defaults to the strict infra policy. */
  private readonly assertEgressAllowed: (url: string) => Promise<void>;

  constructor(options: WebhookDispatcherOptions = {}) {
    this.opts = {
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      ...(options.resolveSecret !== undefined ? { resolveSecret: options.resolveSecret } : {}),
    };
    this.assertEgressAllowed =
      options.assertEgressAllowed ?? ((url: string): Promise<void> => assertEgressAllowed(url));
  }

  async dispatchDue(db: DbOrTx, http: HttpClient, now: Date): Promise<DispatchSummary> {
    const due = await listDueWebhooks(db, now, this.opts.batchSize);
    const summary: DispatchSummary = { processed: 0, sent: 0, retried: 0, dead: 0 };

    for (const row of due) {
      summary.processed += 1;
      const attempts = row.attempts + 1;

      // SSRF egress guard: a tenant-supplied callback_url that points at a
      // private/reserved address (or a non-http scheme) is permanently blocked —
      // dead-letter immediately rather than burning retries on a target that can
      // never legitimately succeed.
      if (await this.egressBlocked(row.url)) {
        await markWebhookDead(db, row.id, attempts);
        summary.dead += 1;
        continue;
      }

      const ok = await this.deliver(http, row.url, row.payload);

      if (ok) {
        await markWebhookSent(db, row.id, attempts);
        summary.sent += 1;
        continue;
      }

      if (attempts >= this.opts.maxAttempts) {
        await markWebhookDead(db, row.id, attempts);
        summary.dead += 1;
        continue;
      }

      const delay = backoffMs(attempts, this.opts.backoffBaseMs, this.opts.backoffMaxMs);
      await rescheduleWebhook(db, row.id, attempts, new Date(now.getTime() + delay));
      summary.retried += 1;
    }

    return summary;
  }

  /** True when the egress guard rejects this url (SSRF target / bad scheme). */
  private async egressBlocked(url: string): Promise<boolean> {
    try {
      await this.assertEgressAllowed(url);
      return false;
    } catch {
      return true;
    }
  }

  /** POST the signed payload; returns `true` on a 2xx, `false` on error/non-2xx. */
  private async deliver(http: HttpClient, url: string, payload: unknown): Promise<boolean> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.resolveSecret !== undefined) {
      const secret = await this.opts.resolveSecret(url);
      if (secret !== undefined) {
        headers[SIGNATURE_HEADER] = signPayload(secret, body);
      }
    }
    try {
      const res = await http.request({ method: 'POST', url, headers, body: payload });
      return res.ok;
    } catch {
      // A network error is a delivery failure; backoff handles the retry.
      return false;
    }
  }
}
