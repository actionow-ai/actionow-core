import { randomUUID } from 'node:crypto';

import type { ChatStreamEvent, StopReason } from '@actionow/contracts';

import { sseEvent } from '../sse.js';

/**
 * Render an IR {@link ChatStreamEvent} stream into Anthropic Messages SSE
 * frames using the typed-event protocol (`event: <name>\ndata: {json}\n\n`).
 * Pure: no network, no SDK runtime.
 *
 * Stateful across events: tracks content-block indices and which block is open,
 * opening a text block on `message_start` and a fresh `tool_use` block (at the
 * next index) on the first `tool_call_delta`. Remembers output tokens from the
 * IR `usage` event for the closing `message_delta`.
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
  let nextIndex = 0;
  let textBlockIndex: number | undefined;
  let toolBlockIndex: number | undefined;
  let openIndex: number | undefined;

  function* closeOpenBlock(): Generator<string> {
    if (openIndex !== undefined) {
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: openIndex });
      openIndex = undefined;
    }
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
        textBlockIndex = nextIndex++;
        openIndex = textBlockIndex;
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        });
        break;
      case 'content_delta':
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex ?? 0,
          delta: { type: 'text_delta', text: event.text },
        });
        break;
      case 'tool_call_delta': {
        // First tool delta: close the current block and open a tool_use block.
        if (toolBlockIndex === undefined) {
          yield* closeOpenBlock();
          toolBlockIndex = nextIndex++;
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
        break;
      case 'stop':
        yield* closeOpenBlock();
        yield sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapStop(event.stopReason), stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        yield sseEvent('message_stop', { type: 'message_stop' });
        return;
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
