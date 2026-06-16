import type {
  AdapterContext,
  CallbackResult,
  PollResult,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

export interface ProviderAdapter {
  readonly providerType: string;
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll?(upstreamJobId: string, ctx: AdapterContext): Promise<PollResult>;
  /**
   * Optional streaming variant. Yields {@link StreamEvent}s (`delta`/`usage`/
   * `done`/`error`). Must clean up (release the HTTP reader) when the consumer
   * stops early — implement as a generator with `try/finally` over the source.
   */
  stream?(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent>;
  parseCallback?(payload: unknown): CallbackResult;
  extractUsage(raw: unknown): UsageVector;
  mapError(raw: unknown): UnifiedError;
}
