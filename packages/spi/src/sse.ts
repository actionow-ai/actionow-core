// packages/spi/src/sse.ts
//
// model-supply-greenfield 批次2 slice 1 — BOUNDED Server-Sent Events framing
// (§6-⑤ 流转码有界缓冲). Same framing semantics as the legacy parser —
// partial lines buffered across chunks, CRLF tolerated, multi-line `data:`
// joined with '\n', `event:` last-wins, `:` comment/heartbeat lines ignored,
// a single leading space after the field colon stripped, trailing un-newlined
// line + unterminated final frame flushed at end of input — but with HARD
// BYTE CEILINGS: the legacy parser's unbounded buffer is a known defect (a
// hostile/broken upstream that never sends a newline, or one enormous event,
// pins memory). Exceeding a ceiling yields ONE terminal error item and stops
// consuming the upstream.
import type { GatewayError } from '@actionow/contracts';

/** Byte ceilings for the framer. Defaults: 1 MiB per event, 4 MiB for the partial-line buffer. */
export interface BoundedSseOptions {
  /** Max UTF-8 bytes ONE event may accumulate across its field lines (default 1 MiB). */
  maxEventBytes?: number;
  /** Max UTF-8 bytes the partial-LINE buffer may hold (an upstream sending no newline; default 4 MiB). */
  maxBufferedBytes?: number;
}

export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * One framer output: a complete SSE event (`event:` field if present, all
 * `data:` lines joined with '\n' — the `[DONE]` sentinel passes through
 * verbatim as `data: '[DONE]'`), or a TERMINAL overflow error (§6-⑤: 超限 →
 * error 帧并终止).
 */
export type BoundedSseItem =
  | { kind: 'event'; event?: string; data: string }
  | { kind: 'error'; error: GatewayError };

function overflowError(detail: string): GatewayError {
  return {
    code: 'upstream_error',
    message: `SSE bounded buffer overflow: ${detail}`,
    retryable: false,
    failover: false,
  };
}

/**
 * Parse decoded UTF-8 text chunks (which may split lines arbitrarily) into
 * SSE events under hard byte ceilings. Pure — no I/O of its own; stops
 * pulling the source the moment a ceiling trips (the returned generator
 * finishes after the error item, so the upstream connection can be dropped).
 */
export async function* parseSseBounded(
  lines: AsyncIterable<string>,
  options?: BoundedSseOptions,
): AsyncIterable<BoundedSseItem> {
  const maxEventBytes = options?.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

  let buffer = '';
  let event: string | undefined;
  const dataLines: string[] = [];
  let sawField = false;
  let eventBytes = 0;

  /** Build the pending frame (if any fields were seen) and reset accumulators. */
  function flush(): BoundedSseItem | undefined {
    if (!sawField) return undefined;
    const data = dataLines.join('\n');
    const item: BoundedSseItem =
      event === undefined ? { kind: 'event', data } : { kind: 'event', event, data };
    event = undefined;
    dataLines.length = 0;
    sawField = false;
    eventBytes = 0;
    return item;
  }

  /** Apply one already-split line (without its newline). Returns a frame to emit, an overflow error, or nothing. */
  function handleLine(rawLine: string): BoundedSseItem | undefined {
    // Strip a trailing CR so CRLF streams frame correctly.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      // Blank line: dispatch the accumulated frame.
      return flush();
    }
    if (line.startsWith(':')) {
      // Comment / heartbeat — ignore (never buffered, never forwarded).
      return undefined;
    }

    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // The spec strips a single leading space from the value.
      if (value.startsWith(' ')) value = value.slice(1);
    }

    if (field === 'event') {
      event = value;
      sawField = true;
      eventBytes += Buffer.byteLength(value, 'utf8');
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
      eventBytes += Buffer.byteLength(value, 'utf8') + 1; // +1 for the '\n' join
    }
    // Other fields (id, retry, …) are accepted but unused.
    if (eventBytes > maxEventBytes) {
      return {
        kind: 'error',
        error: overflowError(`event exceeded ${String(maxEventBytes)} bytes`),
      };
    }
    return undefined;
  }

  for await (const chunk of lines) {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > maxBufferedBytes) {
      yield {
        kind: 'error',
        error: overflowError(`unterminated line exceeded ${String(maxBufferedBytes)} bytes`),
      };
      return; // terminal: stop consuming the upstream
    }
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const item = handleLine(rawLine);
      if (item !== undefined) {
        yield item;
        if (item.kind === 'error') return; // terminal
      }
      nl = buffer.indexOf('\n');
    }
  }

  // Apply any trailing line that arrived without a final newline.
  if (buffer.length > 0) {
    const item = handleLine(buffer);
    if (item !== undefined) {
      yield item;
      if (item.kind === 'error') return;
    }
  }
  // Flush a final frame that was not terminated by a blank line.
  const tail = flush();
  if (tail !== undefined) yield tail;
}
