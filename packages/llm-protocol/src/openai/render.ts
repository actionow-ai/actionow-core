import { randomUUID } from 'node:crypto';

import type { ChatResponse, ChatUsage, StopReason, ToolCall } from '@actionow/contracts';

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

  // The provider's RAW finish reason (OpenRouter `native_finish_reason`): surfaced
  // verbatim alongside the normalized `finish_reason` ONLY when the IR carries it,
  // so a provider that reported a standard reason yields the today-identical shape
  // (regression invariant). When set, `native == finish_reason` for standard reasons.
  const choice: Record<string, unknown> = {
    index: 0,
    message,
    finish_reason: mapStop(res.stopReason),
  };
  if (res.nativeFinishReason !== undefined) {
    choice.native_finish_reason = res.nativeFinishReason;
  }

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
    usage: openAiUsage(res.usage),
  };
}

/**
 * Build the OpenAI wire `usage` from the IR {@link ChatUsage}: the two totals
 * (always), plus `prompt_tokens_details`/`completion_tokens_details` sub-objects
 * surfaced ONLY when the IR carries the corresponding breakdown field — so a
 * provider that did not report it yields the plain back-compat usage shape.
 */
export function openAiUsage(usage: ChatUsage): Record<string, unknown> {
  const { inputTokens, outputTokens } = usage;
  const out: Record<string, unknown> = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
  const promptDetails: Record<string, number> = {};
  if (usage.cachedInputTokens !== undefined) promptDetails.cached_tokens = usage.cachedInputTokens;
  if (usage.audioInputTokens !== undefined) promptDetails.audio_tokens = usage.audioInputTokens;
  if (Object.keys(promptDetails).length > 0) out.prompt_tokens_details = promptDetails;
  const completionDetails: Record<string, number> = {};
  if (usage.reasoningTokens !== undefined)
    completionDetails.reasoning_tokens = usage.reasoningTokens;
  if (usage.audioOutputTokens !== undefined) {
    completionDetails.audio_tokens = usage.audioOutputTokens;
  }
  if (Object.keys(completionDetails).length > 0) out.completion_tokens_details = completionDetails;
  return out;
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
