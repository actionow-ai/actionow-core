import type {
  ChatResponse,
  ChatStreamEvent,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { asNumber, asRecord } from './internal/json.js';
import type { AdapterCapabilities, ProviderAdapter } from './types.js';

const PROVIDER = 'mock-chat';

/** The deterministic content-delta tokens this mock emits, in order. */
const DELTAS: readonly string[] = ['hel', 'lo'];

/** The fixed IR usage this mock reports (camelCase, per the chat IR contract). */
const MOCK_USAGE = { inputTokens: 10, outputTokens: 5 } as const;

const CAPABILITIES: AdapterCapabilities = {
  tools: true,
  vision: true,
  audio: true,
  json: true,
  stream: true,
};

/**
 * In-process mock of an IR chat provider, used by the chat-endpoint e2e to
 * exercise `chat`/`streamChat` without any network.
 *
 * `chat()` returns a fixed assistant message (`'hello'`) with the IR camelCase
 * usage; `streamChat()` yields `message_start` → two `content_delta`s → a
 * `usage` → `stop` → `done`. Pure and deterministic — the context's `http` is
 * never touched.
 */
export function createMockChat(): ProviderAdapter {
  return {
    providerType: PROVIDER,
    capabilities: CAPABILITIES,

    submit(): Promise<SubmitResult> {
      return Promise.resolve({
        kind: 'sync',
        output: { text: DELTAS.join('') },
        usage: { input_tokens: MOCK_USAGE.inputTokens, output_tokens: MOCK_USAGE.outputTokens },
      });
    },

    chat(): Promise<ChatResponse> {
      return Promise.resolve({
        message: { role: 'assistant', content: [{ kind: 'text', text: DELTAS.join('') }] },
        stopReason: 'stop',
        usage: { ...MOCK_USAGE },
      });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'message_start' };
      for (const text of DELTAS) {
        yield { type: 'content_delta', text };
      }
      yield { type: 'usage', usage: { ...MOCK_USAGE } };
      yield { type: 'stop', stopReason: 'stop' };
      yield { type: 'done' };
    },

    extractUsage(raw: unknown): UsageVector {
      const usage = asRecord(asRecord(raw)?.usage);
      return {
        input_tokens: asNumber(usage?.input_tokens) ?? 0,
        output_tokens: asNumber(usage?.output_tokens) ?? 0,
      };
    },

    mapError(): UnifiedError {
      return {
        code: 'upstream_error',
        message: 'mock-chat error',
        upstream: { provider: PROVIDER },
        retryable: false,
      };
    },
  };
}
