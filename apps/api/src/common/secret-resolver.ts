import { Injectable } from '@nestjs/common';

/**
 * STUB secret resolver (Phase 3). A credential `ref` (the `upstream_channel`'s
 * `credential_ref` / a `secret_ref` locator) is resolved to its value by
 * reading `SECRET_<ref>` then `<ref>` from `process.env`. Real vault-backed
 * resolution (`secret_ref.provider = 'vault'`) lands in Phase 5.
 *
 * The resolved value is a secret: it is handed straight to the adapter context
 * and is never logged or returned to clients.
 */
@Injectable()
export class SecretResolver {
  resolve(ref: string): Promise<string | undefined> {
    const envKey = `SECRET_${ref.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const value = process.env[envKey] ?? process.env[ref];
    return Promise.resolve(value);
  }
}
