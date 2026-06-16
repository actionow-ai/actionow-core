import type { StreamEvent, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';

import { asNumber, asRecord } from './internal/json.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'mock-stream';

/** The deterministic delta tokens this mock emits, in order. */
const DELTAS: readonly string[] = ['hel', 'lo'];

/** The fixed usage vector this mock reports at the end of every stream. */
const MOCK_USAGE: UsageVector = { input_tokens: 10, output_tokens: 5 };

/**
 * In-process mock of a streaming text provider, used by tests and the e2e to
 * exercise the `stream` exec mode without any network.
 *
 * `stream()` yields a fixed sequence of `delta` tokens (`'hel'`, `'lo'`), then
 * a `usage` event and a final `done` (both carrying {@link MOCK_USAGE}). It is
 * pure and deterministic — the context's `http` is never touched. `submit()`
 * provides a matching blocking path (the concatenated text + same usage) so the
 * adapter also satisfies the non-streaming modes.
 */
export function createMockStream(): ProviderAdapter {
  return {
    providerType: PROVIDER,

    submit(): Promise<SubmitResult> {
      return Promise.resolve({
        kind: 'sync',
        output: { text: DELTAS.join('') },
        usage: { ...MOCK_USAGE },
      });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(): AsyncIterable<StreamEvent> {
      for (const text of DELTAS) {
        yield { kind: 'delta', text };
      }
      const usage: UsageVector = { ...MOCK_USAGE };
      yield { kind: 'usage', usage };
      yield { kind: 'done', usage };
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
        message: 'mock-stream error',
        upstream: { provider: PROVIDER },
        retryable: false,
      };
    },
  };
}
