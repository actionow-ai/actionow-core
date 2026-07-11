// packages/spi/src/registry.ts
//
// model-supply-greenfield 批次2 slice 1 — VERSIONED dialect assembly (§6
// 热更新一致性): the registry is addressed by EXACT `{ref, version}` — no
// implicit latest, ever — so multiple replicas referencing the same version
// resolve identical behavior, and canary rollout is "switch the version on
// one offering at a time", never a registry-side flip.
import type { DialectRef } from '@actionow/contracts';

import type { Dialect } from './aspects.js';

function keyOf(ref: string, version: string): string {
  return `${ref}@${version}`;
}

/**
 * The in-process dialect registry. Multiple versions of one `ref` coexist
 * (that IS the canary mechanism); registering the same `(ref, version)` twice
 * throws — a version's behavior is immutable once published (publish a new
 * version instead).
 */
export class DialectRegistry {
  private readonly dialects = new Map<string, Dialect>();

  register(dialect: Dialect): void {
    const key = keyOf(dialect.ref, dialect.version);
    if (this.dialects.has(key)) {
      throw new Error(
        `dialect already registered: ${key} (versions are immutable — publish a new version)`,
      );
    }
    this.dialects.set(key, dialect);
  }

  /** Exact `{ref, version}` lookup (供给项/渠道 pin this via dialectRefSchema); undefined when absent — the caller decides how loudly to fail. */
  resolve(ref: DialectRef): Dialect | undefined {
    return this.dialects.get(keyOf(ref.ref, ref.version));
  }

  /** All registered dialects, in registration order. */
  list(): Dialect[] {
    return [...this.dialects.values()];
  }
}
