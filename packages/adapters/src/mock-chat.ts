import type {
  ChatResponse,
  ChatStreamEvent,
  EmbeddingsRequest,
  EmbeddingsResult,
  ModerationRequest,
  ModerationResult,
  RerankRequest,
  RerankResult,
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

/** The fixed per-input-string INPUT token count this mock's `embed` reports. */
const MOCK_EMBED_TOKENS_PER_INPUT = 4;
/** The deterministic embedding vector this mock returns for every input string. */
const MOCK_EMBED_VECTOR: readonly number[] = [0.1, 0.2, 0.3];

/** The fixed per-document INPUT token count this mock's `rerank` reports (+ query). */
const MOCK_RERANK_TOKENS_PER_DOC = 4;
/** The fixed per-input-string INPUT token count this mock's `moderate` reports. */
const MOCK_MODERATE_TOKENS_PER_INPUT = 4;

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

    embed(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
      const inputs = Array.isArray(req.input) ? req.input : [req.input];
      return Promise.resolve({
        vectors: inputs.map(() => [...MOCK_EMBED_VECTOR]),
        usage: { inputTokens: inputs.length * MOCK_EMBED_TOKENS_PER_INPUT },
      });
    },

    rerank(req: RerankRequest): Promise<RerankResult> {
      // Deterministic descending scores by original position (1.0, 0.9, …),
      // honoring `topN` so the relay's slice/shape is exercised. Echoes the doc.
      const ranked = req.documents.map((document, index) => ({
        index,
        relevanceScore: Math.max(0, 1 - index * 0.1),
        document,
      }));
      const results = req.topN === undefined ? ranked : ranked.slice(0, req.topN);
      return Promise.resolve({
        results,
        // INPUT tokens = (#documents + 1 for the query) * per-doc count.
        usage: { inputTokens: (req.documents.length + 1) * MOCK_RERANK_TOKENS_PER_DOC },
      });
    },

    moderate(req: ModerationRequest): Promise<ModerationResult> {
      const inputs = Array.isArray(req.input) ? req.input : [req.input];
      // Deterministic verdict: flag an input iff it contains the literal "bad".
      const results = inputs.map((text) => {
        const flagged = text.includes('bad');
        return {
          flagged,
          categories: { violence: flagged },
          categoryScores: { violence: flagged ? 0.99 : 0.01 },
        };
      });
      return Promise.resolve({
        results,
        usage: { inputTokens: inputs.length * MOCK_MODERATE_TOKENS_PER_INPUT },
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
