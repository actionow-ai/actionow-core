/**
 * Typed guards for safely narrowing `unknown` upstream JSON bodies without
 * resorting to `any`. Adapters parse `HttpResponse.body` (typed `unknown`) with
 * these helpers, then read fields defensively.
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
  return Array.isArray(x) ? x : undefined;
}

/** Narrow to a `string`, or `undefined`. */
export function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

/** Narrow to a finite `number`, or `undefined`. */
export function asNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/** Read a record property as a record (one level of narrowing). */
export function recordAt(x: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(x)?.[key]);
}
