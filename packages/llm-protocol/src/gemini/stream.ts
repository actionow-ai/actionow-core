import type { ChatStreamEvent, ChatUsage, StopReason } from '@actionow/contracts';

import { parseJsonRecord } from '../internal/json.js';
import { sseData } from '../sse.js';

/**
 * Render an IR {@link ChatStreamEvent} stream into Gemini
 * `streamGenerateContent` (`alt=sse`) frames: each `data: {json}\n\n` chunk is
 * shaped like a `GenerateContentResponse`. Pure: no network, no SDK runtime.
 *
 * Mostly stateless per chunk — each `content_delta` yields a candidate chunk
 * with a text part, each `tool_call_delta` carrying a `name` yields a
 * `functionCall` part (Gemini streams whole functionCalls, so the accumulated
 * `argumentsDelta` is parsed into `args`). The terminal `stop` yields a final
 * candidate chunk with `finishReason` + `usageMetadata`. Usage is mapped to
 * Gemini's wire names (`promptTokenCount`/`candidatesTokenCount`/
 * `totalTokenCount`) from the IR camelCase. There is no `[DONE]` sentinel —
 * Gemini's SSE ends at stream close.
 */
export async function* renderGeminiGenerateContentStream(
  events: AsyncIterable<ChatStreamEvent>,
): AsyncIterable<string> {
  let usage: ChatUsage | undefined;
  // Accumulate per-call argument slices keyed by index for whole-functionCall emit.
  const toolArgs = new Map<number, string>();

  const candidateChunk = (
    parts: Record<string, unknown>[],
    finishReason: string | null,
  ): Record<string, unknown> => {
    const candidate: Record<string, unknown> = {
      content: { role: 'model', parts },
      index: 0,
    };
    if (finishReason !== null) candidate.finishReason = finishReason;
    return { candidates: [candidate] };
  };

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        // Gemini has no stream-open frame.
        break;
      case 'content_delta':
        yield sseData(candidateChunk([{ text: event.text }], null));
        break;
      case 'tool_call_delta': {
        const prev = toolArgs.get(event.index) ?? '';
        const accumulated = prev + (event.argumentsDelta ?? '');
        toolArgs.set(event.index, accumulated);
        // Gemini streams whole functionCalls — emit when the name arrives.
        if (event.name !== undefined) {
          const args = parseJsonRecord(accumulated) ?? {};
          yield sseData(candidateChunk([{ functionCall: { name: event.name, args } }], null));
        }
        break;
      }
      case 'usage':
        usage = event.usage;
        break;
      case 'stop': {
        const final: Record<string, unknown> = candidateChunk([], mapStop(event.stopReason));
        if (usage !== undefined) {
          final.usageMetadata = {
            promptTokenCount: usage.inputTokens,
            candidatesTokenCount: usage.outputTokens,
            totalTokenCount: usage.inputTokens + usage.outputTokens,
          };
        }
        yield sseData(final);
        return;
      }
      case 'error':
        yield sseData(candidateChunk([], 'OTHER'));
        return;
      case 'done':
        // Gemini's SSE ends at stream close; no sentinel frame.
        break;
    }
  }
}

/** Map an IR {@link StopReason} → a Gemini `finishReason`. */
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
