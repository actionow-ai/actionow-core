import { getSecretRef } from './catalog.js';
import type { DbOrTx } from './types.js';

/**
 * Matches a canonical RFC-4122 UUID (any version). Used to guard the
 * `secret_ref` DB lookup: querying `WHERE id = <non-uuid>` against the `uuid`
 * column throws a Postgres type error, so the deref is only attempted when
 * `ref` is uuid-shaped.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a value from `process.env` for a credential locator: try
 * `SECRET_<LOCATOR>` (non-alphanumerics → `_`, upper-cased) first, then the
 * raw `<locator>`. The result is a secret — it is handed to the adapter
 * context and is NEVER logged or returned to clients.
 */
function fromEnv(locator: string): string | undefined {
  const envKey = `SECRET_${locator.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  return process.env[envKey] ?? process.env[locator];
}

/**
 * Resolve a credential `ref` to its secret value, dereferencing a `secret_ref`
 * row when `ref` is one. Shared by the api `SecretResolver` and the worker
 * `resolveSecret` closure so both behave identically.
 *
 * Logic (backward-compatible):
 * - When `ref` is uuid-shaped AND a `secret_ref` row exists with `id === ref`,
 *   resolve via that row: `provider === 'env'` → from `SECRET_<locator>` then
 *   `<locator>` in `process.env`. Other providers (e.g. `vault`) return
 *   `undefined` — vault-backed resolution lands in Phase 5 (TODO).
 * - Otherwise (`ref` is not uuid-shaped — e.g. a literal proxy locator like
 *   `upstream_proxy` — or is a uuid with no matching row) fall back to reading
 *   `SECRET_<ref>` then `<ref>` from `process.env`. A uuid with no row yields
 *   `undefined` (no env key matches the formatted uuid).
 *
 * The uuid-format guard is REQUIRED: a `WHERE id = <non-uuid>` lookup against
 * the `uuid` column throws a Postgres type error, so the deref is only
 * attempted for uuid-shaped refs.
 *
 * No secret value is ever logged.
 */
export async function resolveSecretRef(db: DbOrTx, ref: string): Promise<string | undefined> {
  if (UUID_RE.test(ref)) {
    const row = await getSecretRef(db, ref);
    if (row !== undefined) {
      if (row.provider === 'env') return fromEnv(row.locator);
      // TODO(Phase 5): vault-backed (`provider === 'vault'`) resolution.
      return undefined;
    }
    // uuid-shaped but no secret_ref row: fall through to the literal lookup,
    // which will not match (the formatted uuid is not an env key) → undefined.
  }
  return fromEnv(ref);
}
