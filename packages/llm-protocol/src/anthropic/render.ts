import { randomUUID } from 'node:crypto';

import type { ChatResponse, ChatUsage, StopReason, ToolCall } from '@actionow/contracts';

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

  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStop(res.stopReason),
    stop_sequence: null,
    usage: anthropicUsage(res.usage),
  };
}

/**
 * Build the Anthropic wire `usage` from the IR {@link ChatUsage}: the two totals
 * (always), plus `cache_read_input_tokens`/`cache_creation_input_tokens` surfaced
 * ONLY when the IR carries the corresponding breakdown field — so a provider that
 * did not report cache usage yields the plain back-compat usage shape.
 */
export function anthropicUsage(usage: ChatUsage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedInputTokens !== undefined) {
    out.cache_read_input_tokens = usage.cachedInputTokens;
  }
  if (usage.cacheCreationTokens !== undefined) {
    out.cache_creation_input_tokens = usage.cacheCreationTokens;
  }
  return out;
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
