import { randomUUID } from 'node:crypto';

import type { ChatStreamEvent, StopReason } from '@actionow/contracts';

import { sseData } from '../sse.js';
import { openAiUsage } from './render.js';

/**
 * Render an IR {@link ChatStreamEvent} stream into OpenAI
 * `chat.completion.chunk` SSE frames (`data: {json}\n\n`), terminated by the
 * `data: [DONE]\n\n` sentinel. Pure: no network, no SDK runtime.
 *
 * Stateful across events: one `id` + `created` are generated once and shared by
 * every chunk, and a role-bearing opening delta (`{role:'assistant',content:''}`)
 * is emitted exactly once (on `message_start`, or lazily before the first
 * content/tool delta if no `message_start` arrived).
 *
 * Usage is mapped from the IR's camelCase (`inputTokens`/`outputTokens`) to
 * OpenAI's wire names (`prompt_tokens`/`completion_tokens`/`total_tokens`); the
 * usage chunk is emitted only when a `usage` event is seen.
 *
 * A mid-stream `error` (post-commit upstream failure — pre-commit errors surface
 * as real HTTP errors via the engine's pre-stream hold) is rendered as an
 * OpenAI-wire `data: {"error": {...}}` frame and the stream ends WITHOUT the
 * `[DONE]` sentinel — the official SDKs abort on an error frame, and a truncated
 * stream must never masquerade as a clean `finish_reason:"stop"` completion.
 */
export async function* renderOpenAIChatStream(
  events: AsyncIterable<ChatStreamEvent>,
  model: string,
): AsyncIterable<string> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;

  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null,
    nativeFinishReason?: string,
  ): Record<string, unknown> => {
    const choice: Record<string, unknown> = { index: 0, delta, finish_reason: finishReason };
    // OpenRouter `native_finish_reason`: surfaced on the terminal chunk verbatim
    // ONLY when the IR carried it → non-native streams are byte-for-byte unchanged.
    if (nativeFinishReason !== undefined) choice.native_finish_reason = nativeFinishReason;
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [choice],
    };
  };

  function* openRole(): Generator<string> {
    if (!roleSent) {
      roleSent = true;
      yield sseData(chunk({ role: 'assistant', content: '' }, null));
    }
  }

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        yield* openRole();
        break;
      case 'content_delta':
        yield* openRole();
        yield sseData(chunk({ content: event.text }, null));
        break;
      case 'tool_call_delta': {
        yield* openRole();
        const fn: Record<string, unknown> = {};
        if (event.name !== undefined) fn.name = event.name;
        fn.arguments = event.argumentsDelta ?? '';
        const call: Record<string, unknown> = { index: event.index };
        if (event.id !== undefined) call.id = event.id;
        call.type = 'function';
        call.function = fn;
        yield sseData(chunk({ tool_calls: [call] }, null));
        break;
      }
      case 'usage':
        // Real OpenAI usage chunks (stream_options.include_usage) carry an empty
        // `choices` array — not a synthetic empty-delta choice. The breakdown
        // (cached/reasoning/audio details) surfaces only when the IR carries it.
        yield sseData({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: openAiUsage(event.usage),
        });
        break;
      case 'stop':
        yield sseData(chunk({}, mapStop(event.stopReason), event.nativeFinishReason));
        break;
      case 'error':
        // OpenAI-wire error frame: the official SDKs raise an APIError when a
        // `data: {"error": ...}` frame arrives mid-stream. End WITHOUT `[DONE]`
        // so the failure is never mistaken for a clean completion (silent
        // truncation). Mirrors the Anthropic renderer's native `error` event.
        yield sseData({
          error: {
            message: event.error.message,
            type: mapErrorType(event.error.code),
            param: null,
            code: event.error.code,
          },
        });
        return;
      case 'done':
        yield 'data: [DONE]\n\n';
        return;
    }
  }
}

/** Map an IR error code → an OpenAI wire error `type` (mirrors the Anthropic renderer's map). */
function mapErrorType(code: string): string {
  switch (code) {
    case 'invalid_input':
      return 'invalid_request_error';
    case 'unauthorized':
      return 'authentication_error';
    case 'insufficient_credits':
      return 'insufficient_quota';
    case 'rate_limited':
      return 'rate_limit_error';
    default:
      return 'server_error';
  }
}

/** Map an IR {@link StopReason} → an OpenAI `finish_reason`. */
function mapStop(stopReason: StopReason): string {
  switch (stopReason) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'error':
      return 'stop';
  }
}
