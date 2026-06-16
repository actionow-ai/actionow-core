import type {
  AdapterContext,
  CallbackResult,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  PollResult,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

/** A provider's declared chat capabilities, surfaced to the normalization gate. */
export interface AdapterCapabilities {
  tools: boolean;
  vision: boolean;
  audio: boolean;
  json: boolean;
  stream: boolean;
}

export interface ProviderAdapter {
  readonly providerType: string;
  /** Declared chat capabilities; absent → no chat support (submit-only adapter). */
  readonly capabilities?: AdapterCapabilities;
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll?(upstreamJobId: string, ctx: AdapterContext): Promise<PollResult>;
  /**
   * Optional streaming variant. Yields {@link StreamEvent}s (`delta`/`usage`/
   * `done`/`error`). Must clean up (release the HTTP reader) when the consumer
   * stops early — implement as a generator with `try/finally` over the source.
   */
  stream?(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent>;
  /** IR-level blocking chat: preserves tools/multimodal/stopReason/usage. */
  chat?(ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse>;
  /** IR-level streaming chat: yields {@link ChatStreamEvent}s. */
  streamChat?(ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent>;
  parseCallback?(payload: unknown): CallbackResult;
  extractUsage(raw: unknown): UsageVector;
  mapError(raw: unknown): UnifiedError;
}
