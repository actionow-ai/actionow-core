import { randomUUID } from 'node:crypto';

import type { ChatStreamEvent, StopReason } from '@actionow/contracts';

import { sseData } from '../sse.js';

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
 * OpenAI streams have no error frame: the engine's pre-stream hold guarantees
 * errors surface before any bytes, so a mid-stream `error` degrades to a clean
 * stop chunk followed by `[DONE]`.
 */
export async function* renderOpenAIChatStream(
  events: AsyncIterable<ChatStreamEvent>,
  model: string,
): AsyncIterable<string> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let stopped = false;

  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

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
        // `choices` array — not a synthetic empty-delta choice.
        yield sseData({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: event.usage.inputTokens,
            completion_tokens: event.usage.outputTokens,
            total_tokens: event.usage.inputTokens + event.usage.outputTokens,
          },
        });
        break;
      case 'stop':
        stopped = true;
        yield sseData(chunk({}, mapStop(event.stopReason)));
        break;
      case 'error':
        // No OpenAI error frame: degrade to a clean stop chunk.
        if (!stopped) {
          stopped = true;
          yield sseData(chunk({}, 'stop'));
        }
        yield 'data: [DONE]\n\n';
        return;
      case 'done':
        yield 'data: [DONE]\n\n';
        return;
    }
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
