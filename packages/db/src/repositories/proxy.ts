import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull } from 'drizzle-orm';

import { encryptSecret } from '../crypto.js';
import { proxy } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type ProxyRow = InferSelectModel<typeof proxy>;

/** Parse `scheme` + `host:port` from a proxy URL for display columns (never stores creds). */
export function parseProxyUrl(url: string): { scheme: string; host: string } {
  try {
    const u = new URL(url);
    const scheme = u.protocol.replace(/:$/, '');
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return { scheme, host };
  } catch {
    return { scheme: 'unknown', host: '' };
  }
}

/** Fields a caller supplies to {@link createProxy}. The URL is encrypted before insert. */
export interface CreateProxyInput {
  readonly name: string;
  /** The full proxy URL (incl. any credentials) — encrypted at rest. */
  readonly url: string;
  /** Base64 AES-256 master key used to encrypt the URL. */
  readonly keyB64: string;
  readonly status?: string | undefined;
  readonly description?: string | null | undefined;
}

/** Insert a `proxy` row (URL encrypted; scheme/host derived for display). */
export async function createProxy(db: DbOrTx, input: CreateProxyInput): Promise<ProxyRow> {
  const { scheme, host } = parseProxyUrl(input.url);
  const rows = await db
    .insert(proxy)
    .values({
      name: input.name,
      scheme,
      host,
      encryptedUrl: encryptSecret(input.url, input.keyB64),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createProxy: insert returned no row');
  return row;
}

/** List live proxies (excludes soft-deleted), newest-first, keyset-paginated. */
export function listProxies(db: DbOrTx, page: PageParams): Promise<KeysetResult<ProxyRow>> {
  return keysetPage<ProxyRow>(db, {
    table: proxy,
    createdAtCol: proxy.createdAt,
    idCol: proxy.id,
    where: isNull(proxy.deletedAt),
    page,
  });
}

/** Fetch a live proxy by id (soft-deleted → `undefined`). */
export async function getProxyById(db: DbOrTx, id: string): Promise<ProxyRow | undefined> {
  const rows = await db
    .select()
    .from(proxy)
    .where(and(eq(proxy.id, id), isNull(proxy.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Mutable fields of a {@link proxy} (admin PATCH); a new `url` re-derives scheme/host + re-encrypts. */
export interface UpdateProxyInput {
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly keyB64?: string | undefined;
  readonly status?: string | undefined;
  readonly description?: string | null | undefined;
}

/** Patch a live proxy; only supplied fields change. Supplying `url` re-encrypts + re-derives scheme/host. */
export async function updateProxy(
  db: DbOrTx,
  id: string,
  patch: UpdateProxyInput,
): Promise<ProxyRow | undefined> {
  const set: Partial<InferInsertModel<typeof proxy>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.url !== undefined && patch.keyB64 !== undefined) {
    const { scheme, host } = parseProxyUrl(patch.url);
    set.scheme = scheme;
    set.host = host;
    set.encryptedUrl = encryptSecret(patch.url, patch.keyB64);
  }
  if (Object.keys(set).length === 0) return getProxyById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(proxy)
    .set(set)
    .where(and(eq(proxy.id, id), isNull(proxy.deletedAt)))
    .returning();
  return rows[0];
}

/** Record a probe outcome (health/latency/error) for a proxy. */
export interface RecordProxyHealthInput {
  readonly healthy: boolean;
  readonly latencyMs?: number | null | undefined;
  readonly error?: string | null | undefined;
  readonly now: Date;
}

export async function recordProxyHealth(
  db: DbOrTx,
  id: string,
  input: RecordProxyHealthInput,
): Promise<ProxyRow | undefined> {
  const rows = await db
    .update(proxy)
    .set({
      healthy: input.healthy,
      lastCheckedAt: input.now,
      lastLatencyMs: input.latencyMs ?? null,
      lastError: input.error ?? null,
      updatedAt: input.now,
    })
    .where(and(eq(proxy.id, id), isNull(proxy.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete a proxy (frees its name; channels bound to it fall back to no proxy). Idempotent. */
export async function softDeleteProxy(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(proxy)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(proxy.id, id), isNull(proxy.deletedAt)))
    .returning({ id: proxy.id });
  return rows[0]?.id;
}
