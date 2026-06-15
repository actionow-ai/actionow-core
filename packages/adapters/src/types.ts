import type {
  AdapterContext,
  CallbackResult,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

export interface ProviderAdapter {
  readonly providerType: string;
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll?(upstreamJobId: string, ctx: AdapterContext): Promise<PollResult>;
  parseCallback?(payload: unknown): CallbackResult;
  extractUsage(raw: unknown): UsageVector;
  mapError(raw: unknown): UnifiedError;
}
