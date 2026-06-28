/**
 * A minimal, allocation-light Server-Sent-Events (SSE) frame reader for the
 * Actionow streaming endpoints. The data plane emits two SSE shapes:
 *
 *   - `POST /v1/chat/completions` (`stream: true`) — the OpenAI dialect: bare
 *     `data: {json}\n\n` frames, terminated by the literal `data: [DONE]`.
 *   - `POST /v1/run/:resourceId` (`Accept: text/event-stream`) — typed frames:
 *     `event: <kind>\ndata: {json}\n\n` where `<kind>` is `delta`/`usage`/
 *     `done`/`error`.
 *
 * {@link consumeSse} normalizes both into a single `SseFrame` async-iterator so
 * a consumer can `for await` over them without hand-rolling a byte parser. It is
 * a PURE transform over a `Response` (or any byte stream): no SDK runtime, no
 * fetch, no money path — so it is trivially unit-testable.
 */

/** One parsed SSE frame. `event` defaults to `'message'` when no `event:` line is present (per the SSE spec). */
export interface SseFrame {
  /** The `event:` field, or `'message'` when the frame carried only `data:` lines. */
  event: string;
  /** The joined `data:` payload (multiple `data:` lines are `\n`-joined, per spec). Empty string if none. */
  data: string;
  /** The `id:` field if present. */
  id?: string;
  /** The `retry:` reconnection hint in ms if present and numeric. */
  retry?: number;
}

/** The OpenAI stream sentinel: a `data: [DONE]` frame marks end-of-stream. */
export const SSE_DONE = '[DONE]';

/** Parse one raw SSE frame block (lines between blank lines) into a {@link SseFrame}. */
function parseFrame(block: string): SseFrame | undefined {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    // A comment line begins with ':' and is ignored (used for keep-alive pings).
    if (rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    // Per spec, a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n)) retry = n;
        break;
      }
      default:
        // Unknown field — ignore (spec-compliant).
        break;
    }
  }

  // A block with no recognized fields (e.g. trailing whitespace) yields nothing.
  if (event === undefined && dataLines.length === 0 && id === undefined && retry === undefined) {
    return undefined;
  }

  return {
    event: event ?? 'message',
    data: dataLines.join('\n'),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

/**
 * Async-iterate the SSE frames of a streaming `Response`. Decodes the body as
 * UTF-8, splits on the blank-line frame delimiter (`\n\n`, tolerating `\r\n`),
 * and yields one {@link SseFrame} per frame. The OpenAI `data: [DONE]` sentinel
 * is yielded as a frame with `data === '[DONE]'` (compare against {@link SSE_DONE})
 * so the caller decides when to stop — it is NOT swallowed.
 *
 * Pass a `Response` from `fetch` (the SDK client exposes `.response`), or any
 * object with a `ReadableStream<Uint8Array>` `body`. Throws if `body` is null.
 *
 * @example
 * const res = await fetch(`${baseUrl}/v1/chat/completions`, {
 *   method: 'POST',
 *   headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
 *   body: JSON.stringify({ model: 'gpt-4o', messages, stream: true }),
 * });
 * for await (const frame of consumeSse(res)) {
 *   if (frame.data === SSE_DONE) break;
 *   const chunk = JSON.parse(frame.data); // chat.completion.chunk
 *   process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '');
 * }
 */
export async function* consumeSse(
  source: Pick<Response, 'body'>,
): AsyncGenerator<SseFrame, void, undefined> {
  const body = source.body;
  if (body === null) {
    throw new Error('consumeSse: response body is null (not a streaming response)');
  }

  const decoder = new TextDecoder();
  // The DOM lib's `getReader()` overload returns `ReadableStreamDefaultReader<any>`
  // without an explicit cast; pin the element type so `read()`'s `value` is typed.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Emit every complete frame (terminated by a blank line) currently in the
      // buffer; keep the trailing partial frame for the next read.
      let sep = findFrameSeparator(buffer);
      while (sep !== -1) {
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const frame = parseFrame(block);
        if (frame !== undefined) yield frame;
        sep = findFrameSeparator(buffer);
      }
    }

    // Flush any final frame not terminated by a trailing blank line.
    buffer += decoder.decode();
    const tail = parseFrame(buffer.trim());
    if (tail !== undefined) yield tail;
  } finally {
    // Release the lock so the underlying connection can be reused / closed even
    // if the consumer breaks out of the loop early.
    reader.releaseLock();
  }
}

/** Locate the first frame separator (a blank line) in `buf`, tolerating `\r\n`. */
function findFrameSeparator(buf: string): { index: number; length: number } | -1 {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
