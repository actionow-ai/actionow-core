/**
 * Run an e2e per-test DB reset (a `TRUNCATE`) with ONE retry.
 *
 * Under CI Docker resource pressure the Testcontainers Postgres connection
 * occasionally drops mid-`TRUNCATE` — the failure surfaces deep in the driver as
 * `afterConnectMultiple` / `ExecuteTruncateGuts`. Because `TRUNCATE` is atomic it
 * then rolls back entirely, leaving the previous test's rows behind, so the next
 * test's re-seed collides on a unique constraint (first on `user_email_unique`
 * for the seeded admin, and — once that is idempotent — on any other fixed-id row
 * a test re-creates). That makes the whole api e2e suite intermittently red and
 * green-only-on-retry.
 *
 * postgres-js re-establishes the connection on the next query, and `TRUNCATE` is
 * idempotent (re-truncating already-empty tables is a no-op, and a retry after an
 * ack-lost success is harmless), so a single retry makes the reset reliably
 * complete and the suite deterministic. The retry is unconditional: the only
 * realistic `TRUNCATE` failures here are a transient connection drop (retry
 * succeeds) or a genuine schema error (retry fails the same way and still
 * throws), so we don't risk masking a real bug — we only spend one extra attempt.
 *
 * Usage: wrap the existing truncate so the tagged-template (and its exact table
 * list + quoting) is unchanged:
 *
 *   await resetDb(() => client`TRUNCATE TABLE "user" RESTART IDENTITY CASCADE`);
 */
export async function resetDb<T>(run: () => PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch {
    // Transient Testcontainers connection drop mid-TRUNCATE — reconnect + retry
    // once. TRUNCATE is idempotent so this is safe; a real error throws again.
    return await run();
  }
}
