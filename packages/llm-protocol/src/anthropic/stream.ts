import { randomUUID } from 'node:crypto';

import type { ChatStreamEvent, StopReason } from '@actionow/contracts';

import { sseEvent } from '../sse.js';

/**
 * Render an IR {@link ChatStreamEvent} stream into Anthropic Messages SSE
 * frames using the typed-event protocol (`event: <name>\ndata: {json}\n\n`).
 * Pure: no network, no SDK runtime.
 *
 * Stateful across events: tracks content-block indices and which block is open,
 * opening a text block on `message_start`. Each distinct IR tool index maps to
 * its own Anthropic `tool_use` block (via `toolBlockByIrIndex`): a
 * `tool_call_delta` for an IR index with no open block closes the currently-open
 * block and opens a fresh `tool_use` block at the next index, so N distinct tool
 * calls render as N distinct blocks with their own id/name. Text that interleaves
 * after a tool block lazily opens a fresh text block (the original was closed),
 * and text arriving with no `message_start` lazily opens a text block too.
 * Remembers output tokens from the IR `usage` event for the closing
 * `message_delta`.
 *
 * Frame mapping: `message_start` (with model + zeroed `input_tokens`/
 * `output_tokens` usage) + `content_block_start`; each `content_delta` →
 * `content_block_delta` (`text_delta`); each `tool_call_delta` →
 * `content_block_start` (tool_use) and/or `content_block_delta`
 * (`input_json_delta`); `stop` → `content_block_stop` + `message_delta`
 * (carrying `stop_reason` + `usage.output_tokens`) + `message_stop`. Usage uses
 * Anthropic's wire names (`input_tokens`/`output_tokens`), mapped explicitly
 * from the IR camelCase. A mid-stream `error` emits an Anthropic `error` event.
 */
export async function* renderAnthropicMessagesStream(
  events: AsyncIterable<ChatStreamEvent>,
  model: string,
): AsyncIterable<string> {
  const id = `msg_${randomUUID()}`;
  let outputTokens = 0;
  // Cache breakdown captured from the IR usage event (surfaced on message_delta
  // only when the provider reported it).
  let cachedInputTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let nextIndex = 0;
  // The Anthropic block index currently open as a text block (undefined once it
  // has been closed, e.g. when a tool block opened after it).
  let openTextBlockIndex: number | undefined;
  // IR tool index → its dedicated Anthropic tool_use block index.
  const toolBlockByIrIndex = new Map<number, number>();
  // The block index currently open (text or tool), if any.
  let openIndex: number | undefined;

  function* closeOpenBlock(): Generator<string> {
    if (openIndex !== undefined) {
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: openIndex });
      if (openIndex === openTextBlockIndex) openTextBlockIndex = undefined;
      openIndex = undefined;
    }
  }

  function* openTextBlock(): Generator<string, number> {
    const index = nextIndex++;
    openTextBlockIndex = index;
    openIndex = index;
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    return index;
  }

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        yield sseEvent('message_start', {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        yield* openTextBlock();
        break;
      case 'content_delta': {
        // Lazily (re)open a text block: none was opened (no message_start), or
        // the prior text block was closed when a tool block opened.
        let textIndex = openTextBlockIndex;
        if (textIndex === undefined) {
          yield* closeOpenBlock();
          textIndex = yield* openTextBlock();
        }
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: event.text },
        });
        break;
      }
      case 'tool_call_delta': {
        let toolBlockIndex = toolBlockByIrIndex.get(event.index);
        // No block yet for this IR tool index: close whatever is open and open a
        // fresh tool_use block carrying THIS call's id/name.
        if (toolBlockIndex === undefined) {
          yield* closeOpenBlock();
          toolBlockIndex = nextIndex++;
          toolBlockByIrIndex.set(event.index, toolBlockIndex);
          openIndex = toolBlockIndex;
          yield sseEvent('content_block_start', {
            type: 'content_block_start',
            index: toolBlockIndex,
            content_block: {
              type: 'tool_use',
              id: event.id ?? '',
              name: event.name ?? '',
              input: {},
            },
          });
        }
        if (event.argumentsDelta !== undefined) {
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: toolBlockIndex,
            delta: { type: 'input_json_delta', partial_json: event.argumentsDelta },
          });
        }
        break;
      }
      case 'usage':
        outputTokens = event.usage.outputTokens;
        cachedInputTokens = event.usage.cachedInputTokens;
        cacheCreationTokens = event.usage.cacheCreationTokens;
        break;
      case 'stop': {
        yield* closeOpenBlock();
        // Surface the cache breakdown alongside output_tokens, only when reported.
        const usage: Record<string, number> = { output_tokens: outputTokens };
        if (cachedInputTokens !== undefined) usage.cache_read_input_tokens = cachedInputTokens;
        if (cacheCreationTokens !== undefined) {
          usage.cache_creation_input_tokens = cacheCreationTokens;
        }
        yield sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapStop(event.stopReason), stop_sequence: null },
          usage,
        });
        yield sseEvent('message_stop', { type: 'message_stop' });
        return;
      }
      case 'error':
        yield* closeOpenBlock();
        yield sseEvent('error', {
          type: 'error',
          error: { type: mapErrorType(event.error.code), message: event.error.message },
        });
        return;
      case 'done':
        // Anthropic streams terminate via message_stop; nothing extra here.
        break;
    }
  }
}

/** Map an IR {@link StopReason} → an Anthropic streaming `stop_reason`. */
function mapStop(stopReason: StopReason): string {
  switch (stopReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'stop':
    case 'content_filter':
    case 'error':
      return 'end_turn';
  }
}

/** Map an IR error code → an Anthropic SSE `error.type`. */
function mapErrorType(code: string): string {
  switch (code) {
    case 'invalid_input':
      return 'invalid_request_error';
    case 'unauthorized':
      return 'authentication_error';
    case 'rate_limited':
      return 'rate_limit_error';
    case 'upstream_timeout':
      return 'timeout_error';
    case 'upstream_error':
    case 'job_failed':
      return 'overloaded_error';
    default:
      return 'api_error';
  }
}
