import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm/relations';

import type * as schema from '../schema/index.js';

/**
 * A database handle that may be either the root connection (`Database`) or an
 * open transaction. Both `PostgresJsDatabase<typeof schema>` and
 * `PostgresJsTransaction` extend `PgDatabase`, so repository functions accept
 * this shared shape and can run inside `db.transaction(async (tx) => …)`.
 */
export type DbOrTx = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
