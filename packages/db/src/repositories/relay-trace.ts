import type { InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, gte, isNotNull, lte, or, sql } from 'drizzle-orm';

import { relayTrace } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
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

/**
 * The optional correlation/time filters for {@link listRelayTraces}. Each present
 * field narrows the result: the id/type fields by equality, `from`/`to` as an
 * inclusive `created_at` range. All absent → the full audit log.
 */
export interface RelayTraceFilter {
  readonly jobId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly providerType?: string | undefined;
  readonly channelId?: string | undefined;
  /** Inclusive lower bound on `created_at` (`>= from`). */
  readonly from?: Date | undefined;
  /** Inclusive upper bound on `created_at` (`<= to`). */
  readonly to?: Date | undefined;
  /** Exact `response_status` match (e.g. 503). */
  readonly responseStatus?: number | undefined;
  /** Failures only: `response_status >= 400` OR a non-null `error`. */
  readonly errorsOnly?: boolean | undefined;
  /** Restrict to streaming (`true`) or non-streaming (`false`) calls. */
  readonly isStream?: boolean | undefined;
}

/**
 * List `relay_trace` audit rows, keyset-paginated newest-first on
 * `(created_at, id)`. Builds an AND-ed `WHERE` from the present {@link
 * RelayTraceFilter} fields (equality on `job_id`/`tenant_id`/`provider_type`/
 * `channel_id`; an inclusive `created_at` range from `from`/`to`) and composes
 * it with {@link keysetPage}. `relay_trace` is an append-only audit table — it
 * has no `deleted_at`, so there is no soft-delete filter.
 */
export async function listRelayTraces(
  db: DbOrTx,
  filter: RelayTraceFilter,
  page: PageParams,
): Promise<KeysetResult<RelayTraceRow>> {
  const predicates: SQL[] = [];
  if (filter.jobId !== undefined) predicates.push(eq(relayTrace.jobId, filter.jobId));
  if (filter.tenantId !== undefined) predicates.push(eq(relayTrace.tenantId, filter.tenantId));
  if (filter.providerType !== undefined) {
    predicates.push(eq(relayTrace.providerType, filter.providerType));
  }
  if (filter.channelId !== undefined) predicates.push(eq(relayTrace.channelId, filter.channelId));
  if (filter.from !== undefined) predicates.push(gte(relayTrace.createdAt, filter.from));
  if (filter.to !== undefined) predicates.push(lte(relayTrace.createdAt, filter.to));
  if (filter.responseStatus !== undefined) {
    predicates.push(eq(relayTrace.responseStatus, filter.responseStatus));
  }
  if (filter.isStream !== undefined) predicates.push(eq(relayTrace.isStream, filter.isStream));
  if (filter.errorsOnly === true) {
    // A failure = a non-2xx/3xx upstream status OR a captured transport error.
    const errPred = or(sql`${relayTrace.responseStatus} >= 400`, isNotNull(relayTrace.error));
    if (errPred !== undefined) predicates.push(errPred);
  }
  const where = predicates.length === 0 ? undefined : and(...predicates);

  return keysetPage<RelayTraceRow>(db, {
    table: relayTrace,
    createdAtCol: relayTrace.createdAt,
    idCol: relayTrace.id,
    ...(where !== undefined ? { where } : {}),
    page,
  });
}
