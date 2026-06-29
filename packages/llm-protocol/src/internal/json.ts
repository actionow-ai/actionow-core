/**
 * Typed guards for safely narrowing `unknown` wire JSON bodies without resorting
 * to `any`. The dialect parsers narrow inbound wire payloads (typed `unknown`)
 * with these helpers, then read fields defensively.
 *
 * Re-created here (rather than imported from `@actionow/adapters`) because the
 * `@actionow/llm-protocol` package is pure and the import boundary forbids it
 * from depending on adapters.
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

/**
 * Parse a JSON string into a record, returning `undefined` on parse failure or
 * a non-object result. Used to decode SSE `data:` payloads defensively.
 */
export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Collect the body keys NOT in `known` into a typed-but-open `extra` bag for the
 * IR's generic passthrough. `known` lists every key the dialect parser already
 * promotes to a first-class IR field PLUS transport keys (`stream`/`model`/
 * `messages`/etc.) that the adapter rebuilds itself — those must never re-enter
 * the upstream body via `extra`. Returns `undefined` when nothing is left over,
 * so the parser can leave `ir.extra` unset (keeping the shape additive).
 */
export function collectExtra(
  body: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (known.has(k)) continue;
    if (v === undefined) continue;
    extra[k] = v;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}
