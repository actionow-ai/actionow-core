import { randomUUID } from 'node:crypto';

import type { ChatResponse, StopReason, ToolCall } from '@actionow/contracts';

/**
 * Render an IR {@link ChatResponse} into a non-streaming OpenAI
 * `chat.completion` response object. Pure: no network, no SDK runtime.
 *
 * The IR carries usage in camelCase (`inputTokens`/`outputTokens`); this
 * renderer maps it to OpenAI's wire names (`prompt_tokens`/`completion_tokens`).
 */
export function renderOpenAIChat(res: ChatResponse, model: string): Record<string, unknown> {
  const textParts = res.message.content.flatMap((part) =>
    part.kind === 'text' ? [part.text] : [],
  );
  const toolCalls = res.message.toolCalls ?? [];

  // OpenAI uses `null` content when the assistant only emits tool calls.
  const content = textParts.length === 0 && toolCalls.length > 0 ? null : textParts.join('');

  const message: Record<string, unknown> = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(renderToolCall);
  }

  const { inputTokens, outputTokens } = res.usage;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStop(res.stopReason),
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/** Map an IR {@link ToolCall} → an OpenAI assistant `tool_calls[]` entry. */
function renderToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
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
