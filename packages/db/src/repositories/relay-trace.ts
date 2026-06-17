import type { InferSelectModel } from 'drizzle-orm';

import { relayTrace } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type RelayTraceRow = InferSelectModel<typeof relayTrace>;

/**
 * Fields a caller supplies to {@link insertRelayTrace}. Mirrors the
 * `relay_trace` columns; the correlation ids/providerType are optional (a trace
 * may be captured before they are all known), and the bodies/headers are
 * already redacted + truncated by the `TracingHttpClient` before they arrive
 * here (the repo stores them verbatim).
 */
export interface InsertRelayTraceInput {
  readonly tenantId?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly channelId?: string | null | undefined;
  readonly providerType?: string | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders?: Record<string, string> | null | undefined;
  readonly requestBody?: string | null | undefined;
  readonly responseStatus?: number | null | undefined;
  readonly responseBody?: string | null | undefined;
  readonly isStream?: boolean | undefined;
  readonly latencyMs?: number | null | undefined;
  readonly error?: string | null | undefined;
  readonly truncated?: boolean | undefined;
}

/**
 * Insert one `relay_trace` audit row and return it. Best-effort by contract:
 * the caller (`TracingHttpClient` sink) wraps this in a try/catch and swallows
 * any error so a trace-write failure never breaks the relayed request.
 */
export async function insertRelayTrace(
  db: DbOrTx,
  input: InsertRelayTraceInput,
): Promise<RelayTraceRow> {
  const rows = await db
    .insert(relayTrace)
    .values({
      tenantId: input.tenantId ?? null,
      jobId: input.jobId ?? null,
      channelId: input.channelId ?? null,
      providerType: input.providerType ?? null,
      method: input.method,
      url: input.url,
      requestHeaders: input.requestHeaders ?? null,
      requestBody: input.requestBody ?? null,
      responseStatus: input.responseStatus ?? null,
      responseBody: input.responseBody ?? null,
      ...(input.isStream !== undefined ? { isStream: input.isStream } : {}),
      latencyMs: input.latencyMs ?? null,
      error: input.error ?? null,
      ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertRelayTrace: insert returned no row');
  return row;
}
