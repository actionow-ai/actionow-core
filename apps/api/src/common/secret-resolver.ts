import { type Database, resolveSecretRef } from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import { DB } from './tokens.js';

/**
 * Resolves a credential `ref` to its secret value. A channel's `credential_ref`
 * is the uuid of a `secret_ref` row: the resolver dereferences that row and,
 * for `provider = 'env'`, reads `SECRET_<locator>` then `<locator>` from
 * `process.env` (e.g. locator `my-key` → `SECRET_MY_KEY`). A non-uuid ref
 * (e.g. a literal proxy locator like `upstream_proxy`, or a dev value) is read
 * directly from `SECRET_<ref>` then `<ref>`. Vault-backed `secret_ref`s
 * (`provider = 'vault'`) return `undefined` until Phase 5.
 *
 * The shared {@link resolveSecretRef} helper (db package) carries the logic so
 * the worker's `resolveSecret` closure stays identical.
 *
 * The resolved value is a secret: it is handed straight to the adapter context
 * and is never logged or returned to clients.
 */
@Injectable()
export class SecretResolver {
  constructor(@Inject(DB) private readonly db: Database) {}

  resolve(ref: string): Promise<string | undefined> {
    return resolveSecretRef(this.db, ref);
  }
}
