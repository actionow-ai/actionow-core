import type { ChatResponse, ChatUsage, StopReason, ToolCall } from '@actionow/contracts';

/**
 * Render an IR {@link ChatResponse} into a non-streaming Gemini
 * `generateContent` response object. Pure: no network, no SDK runtime.
 *
 * The IR carries usage in camelCase (`inputTokens`/`outputTokens`); this
 * renderer maps it to Gemini's wire usage names
 * (`promptTokenCount`/`candidatesTokenCount`/`totalTokenCount`) — the IR shape
 * is NOT passed through. Gemini's response carries no `model` field, so none is
 * required here.
 */
export function renderGeminiChat(res: ChatResponse): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  for (const part of res.message.content) {
    if (part.kind === 'text') {
      parts.push({ text: part.text });
    }
  }
  for (const call of res.message.toolCalls ?? []) {
    parts.push(renderToolCall(call));
  }

  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: mapStop(res.stopReason),
        index: 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: geminiUsageMetadata(res.usage),
  };
}

/**
 * Build the Gemini wire `usageMetadata` from the IR {@link ChatUsage}: the totals
 * (always), plus `thoughtsTokenCount`/`cachedContentTokenCount` surfaced ONLY when
 * the IR carries the corresponding breakdown field — so a provider that did not
 * report thoughts/cache yields the plain back-compat usageMetadata shape.
 */
export function geminiUsageMetadata(usage: ChatUsage): Record<string, unknown> {
  const { inputTokens, outputTokens } = usage;
  const out: Record<string, unknown> = {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: inputTokens + outputTokens,
  };
  if (usage.reasoningTokens !== undefined) out.thoughtsTokenCount = usage.reasoningTokens;
  if (usage.cachedInputTokens !== undefined) out.cachedContentTokenCount = usage.cachedInputTokens;
  return out;
}

/** Map an IR {@link ToolCall} → a Gemini `functionCall` part. */
function renderToolCall(call: ToolCall): Record<string, unknown> {
  return { functionCall: { name: call.name, args: call.arguments } };
}

/**
 * Map an IR {@link StopReason} → a Gemini `finishReason`. Gemini has no
 * tool-specific finish — the `functionCall` part signals it — so `tool_calls`
 * maps to `STOP`.
 */
function mapStop(stopReason: StopReason): string {
  switch (stopReason) {
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    case 'error':
      return 'OTHER';
    case 'stop':
    case 'tool_calls':
      return 'STOP';
  }
}
