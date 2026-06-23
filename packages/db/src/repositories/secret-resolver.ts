import { and, eq, isNull } from 'drizzle-orm';

import { decryptSecret, encryptSecret } from '../crypto.js';
import { proxy, secretMaterial, secretRef } from '../schema/index.js';
import { getSecretRef, type SecretRefRow } from './catalog.js';
import { getDecryptedOAuthSession } from './oauth-session.js';
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
 *   `<locator>` in `process.env`; `provider === 'enc'` → AES-GCM-decrypt the
 *   1:1 `secret_material` ciphertext with the `SECRET_ENCRYPTION_KEY` master
 *   key (a missing key, missing material, bad key, or tampered ciphertext all
 *   resolve to `undefined` — never a throw); `provider === 'oauth'` →
 *   AES-GCM-decrypt the 1:1 `oauth_session` and return the LIVE access token
 *   (freshness is kept by the refresh sweep; a non-`active` status, missing
 *   key, or any decrypt error resolves to `undefined` — never a throw, no
 *   network/refresh happens here). Other providers (e.g. `vault`) return
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
      if (row.provider === 'enc') {
        const keyB64 = process.env.SECRET_ENCRYPTION_KEY;
        if (keyB64 === undefined || keyB64 === '') return undefined; // misconfig → unresolved
        const [mat] = await db
          .select()
          .from(secretMaterial)
          .where(eq(secretMaterial.secretRefId, row.id))
          .limit(1);
        if (mat === undefined) return undefined;
        try {
          return decryptSecret(mat.material, keyB64);
        } catch {
          return undefined; // bad key / tampered → unresolved, never throw to callers
        }
      }
      if (row.provider === 'oauth') {
        const keyB64 = process.env.SECRET_ENCRYPTION_KEY;
        if (keyB64 === undefined || keyB64 === '') return undefined; // misconfig → unresolved
        try {
          const session = await getDecryptedOAuthSession(db, row.id, keyB64);
          if (session?.status !== 'active') return undefined;
          return session.accessToken; // live access token; freshness via the refresh sweep
        } catch {
          return undefined; // never throw to callers (mirrors the enc branch)
        }
      }
      // TODO(Phase 5): vault-backed (`provider === 'vault'`) resolution.
      return undefined;
    }
    // uuid-shaped but no secret_ref row: it may be a MANAGED PROXY id
    // (`upstream_channel.proxy_ref = proxy.id`). An ACTIVE proxy resolves to its
    // AES-GCM-decrypted URL; a disabled/soft-deleted proxy resolves to undefined
    // (→ the engine falls back to the global UPSTREAM_PROXY_URL / no proxy).
    const proxyUrl = await resolveProxyRef(db, ref);
    if (proxyUrl !== undefined) return proxyUrl;
    // else fall through to the literal env lookup (won't match a uuid) → undefined.
  }
  return fromEnv(ref);
}

/**
 * Resolve a uuid `ref` that names an ACTIVE managed {@link proxy} to its
 * decrypted URL. A non-active / soft-deleted / missing proxy, a missing
 * encryption key, or a decrypt error all resolve to `undefined` (never throw).
 */
async function resolveProxyRef(db: DbOrTx, ref: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(proxy)
    .where(and(eq(proxy.id, ref), isNull(proxy.deletedAt)))
    .limit(1);
  if (row?.status !== 'active') return undefined;
  const keyB64 = process.env.SECRET_ENCRYPTION_KEY;
  if (keyB64 === undefined || keyB64 === '') return undefined;
  try {
    return decryptSecret(row.encryptedUrl, keyB64);
  } catch {
    return undefined;
  }
}

/** Fields a caller supplies to {@link createEncryptedSecret}. */
export interface CreateEncryptedSecretInput {
  /** The plaintext secret to encrypt at rest. Never persisted in the clear. */
  readonly value: string;
  /** Optional human label, stored as the `secret_ref` locator (defaults to `''`). */
  readonly label?: string | undefined;
  /** Base64 AES-256 master key used to encrypt the value. */
  readonly keyB64: string;
}

/**
 * Create a `provider='enc'` secret_ref + its AES-GCM material in one transaction.
 * The plaintext is encrypted before insert; only the ciphertext is persisted.
 */
export async function createEncryptedSecret(
  db: DbOrTx,
  input: CreateEncryptedSecretInput,
): Promise<SecretRefRow> {
  const material = encryptSecret(input.value, input.keyB64);
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .insert(secretRef)
      .values({ provider: 'enc', locator: input.label ?? '' })
      .returning();
    if (!ref) throw new Error('createEncryptedSecret: secret_ref insert returned no row');
    await tx.insert(secretMaterial).values({ secretRefId: ref.id, material });
    return ref;
  });
}
