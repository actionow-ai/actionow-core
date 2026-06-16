import { randomUUID } from 'node:crypto';

import type { ChatResponse, StopReason, ToolCall } from '@actionow/contracts';

/**
 * Render an IR {@link ChatResponse} into a non-streaming Anthropic Messages
 * response object. Pure: no network, no SDK runtime.
 *
 * The IR carries usage in camelCase (`inputTokens`/`outputTokens`); this
 * renderer sets Anthropic's wire usage names (`input_tokens`/`output_tokens`)
 * explicitly — the IR shape is NOT passed through.
 */
export function renderAnthropicChat(res: ChatResponse, model: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  for (const part of res.message.content) {
    if (part.kind === 'text') {
      content.push({ type: 'text', text: part.text });
    }
  }
  for (const call of res.message.toolCalls ?? []) {
    content.push(renderToolCall(call));
  }

  const { inputTokens, outputTokens } = res.usage;

  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStop(res.stopReason),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/** Map an IR {@link ToolCall} → an Anthropic `tool_use` content block. */
function renderToolCall(call: ToolCall): Record<string, unknown> {
  return { type: 'tool_use', id: call.id, name: call.name, input: call.arguments };
}

/** Map an IR {@link StopReason} → an Anthropic `stop_reason`. */
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
