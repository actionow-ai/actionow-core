/**
 * Typed guards for safely narrowing the `unknown` parsed Dify DSL without
 * resorting to `any`. The DSL is external YAML, so every field read goes
 * through these helpers (the same defensive pattern as the adapters' JSON
 * guards) before being trusted.
 */

/** Narrow to a plain object, or `undefined` for non-objects/arrays/null. */
export function asRecord(x: unknown): Record<string, unknown> | undefined {
  if (typeof x === 'object' && x !== null && !Array.isArray(x)) {
    return x as Record<string, unknown>;
  }
  return undefined;
}

/** Narrow to an array of `unknown`, or `undefined`. */
export function asArray(x: unknown): unknown[] | undefined {
  return Array.isArray(x) ? (x as unknown[]) : undefined;
}

/** Narrow to a `string`, or `undefined`. */
export function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

/** Narrow to a finite `number`, or `undefined`. */
export function asNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/** Narrow to a `boolean`, or `undefined`. */
export function asBoolean(x: unknown): boolean | undefined {
  return typeof x === 'boolean' ? x : undefined;
}

/** Read a record property as a record (one level of narrowing). */
export function recordAt(x: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(x)?.[key]);
}

/** Narrow an array of `unknown` into an array of `string`, dropping non-strings. */
export function asStringArray(x: unknown): string[] | undefined {
  const arr = asArray(x);
  if (arr === undefined) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of arr) {
    const s = asString(item);
    if (s !== undefined) {
      out.push(s);
    }
  }
  return out;
}
