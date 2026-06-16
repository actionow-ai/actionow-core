/**
 * Minimal Server-Sent Events (SSE) framing parser.
 *
 * Consumes decoded UTF-8 text chunks (which may split lines arbitrarily) and
 * yields one frame per SSE event — i.e. per group of lines terminated by a
 * blank line. Each frame collects the `event:` field (last wins) and joins
 * every `data:` field with `\n` (the SSE spec's multi-line data rule).
 *
 * Per the spec we:
 * - buffer partial lines across chunks (a `\n` may arrive in a later chunk);
 * - tolerate CRLF by stripping a trailing `\r`;
 * - ignore comment lines (those beginning with `:`, used for heartbeats);
 * - strip a single leading space after the field's colon.
 *
 * The `[DONE]` sentinel is passed through verbatim as `data: '[DONE]'`; it is
 * the caller's job to recognise and stop. Pure: no I/O of its own.
 */
export async function* parseSse(
  lines: AsyncIterable<string>,
): AsyncIterable<{ event?: string; data: string }> {
  let buffer = '';
  let event: string | undefined;
  const dataLines: string[] = [];
  let sawField = false;

  /** Build the pending frame (if any fields were seen) and reset accumulators. */
  function flush(): { event?: string; data: string } | undefined {
    if (!sawField) {
      return undefined;
    }
    const data = dataLines.join('\n');
    const frame: { event?: string; data: string } =
      event === undefined ? { data } : { event, data };
    event = undefined;
    dataLines.length = 0;
    sawField = false;
    return frame;
  }

  /** Apply one already-split line (without its newline) to the current frame. */
  function handleLine(rawLine: string): { event?: string; data: string } | undefined {
    // Strip a trailing CR so CRLF streams frame correctly.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      // Blank line: dispatch the accumulated frame.
      return flush();
    }
    if (line.startsWith(':')) {
      // Comment / heartbeat — ignore.
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
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
    // Other fields (id, retry, …) are accepted but unused.
    return undefined;
  }

  for await (const chunk of lines) {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const frame = handleLine(rawLine);
      if (frame !== undefined) {
        yield frame;
      }
      nl = buffer.indexOf('\n');
    }
  }

  // Apply any trailing line that arrived without a final newline.
  if (buffer.length > 0) {
    const frame = handleLine(buffer);
    if (frame !== undefined) {
      yield frame;
    }
  }
  // Flush a final frame that was not terminated by a blank line.
  const tail = flush();
  if (tail !== undefined) {
    yield tail;
  }
}
