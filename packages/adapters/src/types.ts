import type {
  AdapterContext,
  CallbackResult,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  PollResult,
  ProviderModel,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

/**
 * A provider adapter's declared chat capabilities. NOTE: not yet consulted by the
 * dispatch-time gate (the relay gates against the resolved MODEL row's
 * capabilities); adapters additionally REJECT content parts they cannot represent
 * (see openai/anthropic `irPart*`) so an over-claimed model can never silently
 * downgrade. Wiring these into capability-aware channel selection is a follow-up.
 */
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
  /**
   * Optional model discovery: query the provider's official catalog endpoint and
   * return its available models as provider-neutral {@link ProviderModel}s. Absent
   * → the provider does not support model sync (the admin sync endpoint rejects).
   */
  listModels?(ctx: AdapterContext): Promise<ProviderModel[]>;
  extractUsage(raw: unknown): UsageVector;
  mapError(raw: unknown): UnifiedError;
}
