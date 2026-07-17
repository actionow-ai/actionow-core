// packages/spi/src/dsl/jsonpath.ts
//
// model-supply-greenfield 批次2 slice 2 — a MINIMAL JSON pointer for the DSL
// engine (§6 DSL: wire 字段位置映射 / usage 提取 / 状态映射 all address body and
// response positions by path). Deliberately NOT a jsonpath library — only the
// two forms the DSL needs: dotted object keys (`$.a.b.c`) and non-negative
// array subscripts (`$.items[0].url`). `getPath` reads (a missing hop → the
// whole read is `undefined`, never a throw); `setPath` writes and builds the
// intermediate containers it descends through. Both PURE, no dependencies.

/** One parsed step of a `$`-rooted path: an object key or an array index. */
export type JsonPathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

/**
 * Parse a `$`-rooted path into segments. Grammar: a leading `$`, then zero or
 * more `.key` (object key) or `[n]` (non-negative array index) steps — `$`
 * alone is the root (no segments). Throws {@link TypeError} on a malformed path
 * (missing `$` root, empty key, non-numeric/negative index, unterminated `[`,
 * stray characters) so authoring defects surface loudly rather than silently
 * mis-addressing.
 */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (!path.startsWith('$')) {
    throw new TypeError(`json path must start with "$": ${JSON.stringify(path)}`);
  }
  const segments: JsonPathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path.charAt(i);
    if (ch === '.') {
      i += 1;
      let key = '';
      while (i < path.length && path.charAt(i) !== '.' && path.charAt(i) !== '[') {
        key += path.charAt(i);
        i += 1;
      }
      if (key.length === 0) {
        throw new TypeError(`json path has an empty key: ${JSON.stringify(path)}`);
      }
      segments.push({ kind: 'key', key });
    } else if (ch === '[') {
      i += 1;
      let digits = '';
      while (i < path.length && path.charAt(i) !== ']') {
        digits += path.charAt(i);
        i += 1;
      }
      if (i >= path.length) {
        throw new TypeError(`json path has an unterminated "[": ${JSON.stringify(path)}`);
      }
      i += 1; // consume ']'
      if (digits.length === 0 || !/^\d+$/.test(digits)) {
        throw new TypeError(
          `json path array index must be a non-negative integer: ${JSON.stringify(path)}`,
        );
      }
      segments.push({ kind: 'index', index: Number.parseInt(digits, 10) });
    } else {
      throw new TypeError(
        `json path has an unexpected character ${JSON.stringify(ch)}: ${JSON.stringify(path)}`,
      );
    }
  }
  return segments;
}

/**
 * Read the value at `path` from `root`. Any missing / type-mismatched hop
 * (descending a key into a non-object, an index into a non-array, or through
 * `null`/`undefined`) short-circuits to `undefined`. `$` alone returns `root`.
 */
export function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of parseJsonPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (segment.kind === 'key') {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment.key];
    } else {
      if (!Array.isArray(current)) return undefined;
      current = (current as unknown[])[segment.index];
    }
  }
  return current;
}

function asRecord(container: Record<string, unknown> | unknown[]): Record<string, unknown> {
  if (Array.isArray(container)) {
    throw new TypeError('json path expected an object container but found an array');
  }
  return container;
}

function asArray(container: Record<string, unknown> | unknown[]): unknown[] {
  if (!Array.isArray(container)) {
    throw new TypeError('json path expected an array container but found an object');
  }
  return container;
}

/**
 * Descend one segment, materializing the child container when absent (an array
 * when the NEXT segment is an index, else an object). Reuses an existing
 * object/array child; a scalar occupying the slot is a genuine authoring
 * conflict and surfaces as a `TypeError` on the following hop.
 */
function descend(
  container: Record<string, unknown> | unknown[],
  segment: JsonPathSegment,
  nextIsIndex: boolean,
): Record<string, unknown> | unknown[] {
  const existing =
    segment.kind === 'key' ? asRecord(container)[segment.key] : asArray(container)[segment.index];
  if (existing !== null && typeof existing === 'object') {
    return existing as Record<string, unknown> | unknown[];
  }
  const created: Record<string, unknown> | unknown[] = nextIsIndex ? [] : {};
  if (segment.kind === 'key') {
    asRecord(container)[segment.key] = created;
  } else {
    asArray(container)[segment.index] = created;
  }
  return created;
}

/**
 * Write `value` at `path` into `target`, building the intermediate object /
 * array containers it passes through. The root `target` is always an object,
 * so a path's first step must be a key (a root-level `$[0]` throws). Writing to
 * `$` (the root) throws.
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = parseJsonPath(path);
  const last = segments[segments.length - 1];
  if (last === undefined) {
    throw new TypeError(`cannot write to the root json path ${JSON.stringify(path)}`);
  }
  let container: Record<string, unknown> | unknown[] = target;
  for (let idx = 0; idx < segments.length - 1; idx += 1) {
    const segment = segments[idx];
    const next = segments[idx + 1];
    if (segment === undefined || next === undefined) return; // unreachable under the loop bound
    container = descend(container, segment, next.kind === 'index');
  }
  if (last.kind === 'key') {
    asRecord(container)[last.key] = value;
  } else {
    asArray(container)[last.index] = value;
  }
}
