import type { InferInsertModel } from 'drizzle-orm';

import { ledgerTxn } from '../schema/index.js';
import type { DbOrTx } from './types.js';

/**
 * Fields a caller supplies when appending a `ledger_txn` row. The `id` and
 * `created_at` columns are DB-defaulted, so they are omitted here. The caller
 * is responsible for `type`, `creditsDelta`, `balanceAfter` (read post-update),
 * `jobId`, and the version/usage snapshot columns.
 */
export type LedgerInput = Omit<InferInsertModel<typeof ledgerTxn>, 'id' | 'createdAt'>;

/**
 * Append a single append-only `ledger_txn` row. Pure insert — the caller owns
 * the surrounding transaction and supplies the post-update `balanceAfter`.
 */
export async function appendLedger(db: DbOrTx, txn: LedgerInput): Promise<void> {
  await db.insert(ledgerTxn).values(txn);
}
